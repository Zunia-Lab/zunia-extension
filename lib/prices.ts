/**
 * Optional spot prices.
 *
 * Shares the live-reads opt-in with `balances.ts`. Without that host
 * permission every call returns an empty map.
 *
 * CoinGecko's batch routes, `/simple/price` and `/coins/markets`, are behind
 * CloudFront. With no demo API key they answer 403 and the HTML page
 * "The request could not be satisfied". The per-coin route still returns
 * JSON, including the USD price and the 24h change, so that is the call we
 * make. A demo key is not shipped in the extension. A chain with no
 * `coinGeckoId` stays unpriced, unless config/prices.ts names an on-chain pool
 * for it (SAF on Osmosis): that price carries its `source`.
 */

import { POOL_PRICE_SOURCES, type PoolPriceSource } from "../config/prices";
import { findCatalogEntry } from "./chain-catalog";
import { hasLiveBalancePermission } from "./balances";
import { getSettings } from "./settings";
import { STORAGE_KEYS } from "./storage-keys";

/** Currencies the price endpoint is asked for. Keep in sync with settings. */
export const SUPPORTED_CURRENCIES = ["usd", "eur", "gbp", "jpy"] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

export interface SpotPrice {
  /** Price of one whole coin in the requested currency. */
  price: number;
  /** 24h change as a percentage, e.g. `-1.24`. */
  change24h: number;
  /**
   * Set when the price comes from one on-chain pool rather than CoinGecko's
   * aggregate, so every surface can say where it comes from.
   */
  source?: { name: string; pair: string; url: string };
}

/** Prices keyed by chain id. */
export type PriceMap = Record<string, SpotPrice>;

const COIN_ENDPOINT = "https://api.coingecko.com/api/v3/coins/";
/** A few at a time. The free CoinGecko route rejects a burst with 429. */
const CONCURRENCY = 4;
const CACHE_TTL_MS = 120_000;
const REQUEST_TIMEOUT_MS = 8_000;

interface CacheRecord {
  fetchedAt: number;
  currency: string;
  prices: PriceMap;
}

interface CoinQuote {
  id: string;
  price: number;
  change24h: number;
}

export function normaliseCurrency(value: string): SupportedCurrency {
  const lower = value.toLowerCase();
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(lower)
    ? (lower as SupportedCurrency)
    : "usd";
}

/** The on-chain pool a chain is priced from, when it has no CoinGecko id. */
export function poolSourceFor(
  chainId: string,
  sources: Readonly<Record<string, PoolPriceSource>> = POOL_PRICE_SOURCES,
): PoolPriceSource | null {
  if (findCatalogEntry(chainId)?.coinGeckoId) return null;
  return sources[chainId] ?? null;
}

/** Chain ids that can be priced at all, so callers can explain the gap. */
export function priceableChainIds(chainIds: readonly string[]): string[] {
  return chainIds.filter((id) => findCatalogEntry(id)?.coinGeckoId || poolSourceFor(id));
}

/**
 * The pool's price and its 24h change, in the pool's quote asset: the spot
 * price (`/osmosis/poolmanager/v2/pools/{id}/prices`) against the arithmetic
 * TWAP over the hour that ended 24 hours ago. Null for anything it cannot read
 * whole; a missing TWAP leaves the change at 0 rather than inventing one.
 */
export function parsePoolQuote(
  spotBody: unknown,
  twapBody: unknown,
): { price: number; change24h: number } | null {
  const price = Number((spotBody as { spot_price?: unknown } | null)?.spot_price);
  if (!Number.isFinite(price) || !(price > 0)) return null;
  const before = Number((twapBody as { arithmetic_twap?: unknown } | null)?.arithmetic_twap);
  const change24h = Number.isFinite(before) && before > 0 ? ((price - before) / before) * 100 : 0;
  return { price, change24h };
}

export async function getPrices(
  chainIds: readonly string[],
  options: { force?: boolean } = {},
): Promise<PriceMap> {
  const settings = await getSettings();
  if (!settings.liveBalances || !(await hasLiveBalancePermission())) return {};

  const currency = normaliseCurrency(settings.currency ?? "usd");

  // One registry id can back several chains, so map both directions.
  const idsByChain = new Map<string, string>();
  const poolChains = new Map<string, PoolPriceSource>();
  for (const chainId of chainIds) {
    const geckoId = findCatalogEntry(chainId)?.coinGeckoId;
    if (geckoId) idsByChain.set(chainId, geckoId);
    const source = poolSourceFor(chainId);
    if (source) poolChains.set(chainId, source);
  }
  if (idsByChain.size === 0 && poolChains.size === 0) return {};

  const cached = (await browser.storage.local.get(STORAGE_KEYS.priceCache))[
    STORAGE_KEYS.priceCache
  ] as CacheRecord | undefined;
  const fresh =
    !options.force &&
    cached &&
    cached.currency === currency &&
    Date.now() - cached.fetchedAt < CACHE_TTL_MS &&
    [...idsByChain.keys(), ...poolChains.keys()].every((id) => cached.prices[id]);
  if (fresh && cached) return cached.prices;

  // The pools' quote assets too (USDC), to convert into the user's currency.
  const unique = [
    ...new Set([...idsByChain.values(), ...[...poolChains.values()].map((s) => s.quoteGeckoId)]),
  ].sort();
  const [quotes, pools] = await Promise.all([
    mapPool(unique, CONCURRENCY, (id) => fetchCoinQuote(id, currency)),
    mapPool([...poolChains.entries()], CONCURRENCY, async ([chainId, source]) => ({
      chainId,
      source,
      quote: await fetchPoolQuote(source),
    })),
  ]);
  const byId = new Map(
    quotes.flatMap((quote) => (quote ? [[quote.id, quote] as const] : [])),
  );

  const prices: PriceMap = {};
  for (const [chainId, geckoId] of idsByChain) {
    const quote = byId.get(geckoId);
    if (!quote) continue;
    prices[chainId] = { price: quote.price, change24h: quote.change24h };
  }
  for (const { chainId, source, quote } of pools) {
    // The quote asset (USDC) in the user's currency; without its quote only
    // USD can assume par.
    const unit = byId.get(source.quoteGeckoId)?.price ?? (currency === "usd" ? 1 : null);
    if (!quote || unit === null) continue;
    prices[chainId] = {
      price: quote.price * unit,
      change24h: quote.change24h,
      source: { name: source.name, pair: source.pair, url: source.url },
    };
  }

  if (Object.keys(prices).length === 0) {
    return cached?.currency === currency ? cached.prices : {};
  }

  await browser.storage.local.set({
    [STORAGE_KEYS.priceCache]: {
      fetchedAt: Date.now(),
      currency,
      prices,
    } satisfies CacheRecord,
  });
  return prices;
}

export async function clearPriceCache(): Promise<void> {
  await browser.storage.local.remove(STORAGE_KEYS.priceCache);
}

async function fetchCoinQuote(
  id: string,
  currency: SupportedCurrency,
): Promise<CoinQuote | null> {
  const url =
    `${COIN_ENDPOINT}${encodeURIComponent(id)}` +
    "?localization=false&tickers=false&market_data=true" +
    "&community_data=false&developer_data=false&sparkline=false";
  try {
    const body = (await fetchJson(url)) as {
      market_data?: {
        current_price?: Record<string, number>;
        price_change_percentage_24h_in_currency?: Record<string, number>;
        price_change_percentage_24h?: number;
      };
    };
    const price = body.market_data?.current_price?.[currency];
    if (typeof price !== "number") return null;
    const change =
      body.market_data?.price_change_percentage_24h_in_currency?.[currency] ??
      body.market_data?.price_change_percentage_24h ??
      0;
    return { id, price, change24h: change };
  } catch {
    return null;
  }
}

async function fetchPoolQuote(
  source: PoolPriceSource,
): Promise<{ price: number; change24h: number } | null> {
  const rest = findCatalogEntry(source.chainId)?.rest?.replace(/\/+$/, "");
  if (!rest) return null;
  const base = encodeURIComponent(source.baseDenom);
  const quote = encodeURIComponent(source.quoteDenom);
  const hour = 3_600_000;
  const start = new Date(Date.now() - 25 * hour).toISOString().replace(/\.\d{3}Z$/, "Z");
  const end = new Date(Date.now() - 24 * hour).toISOString().replace(/\.\d{3}Z$/, "Z");
  try {
    const [spot, twap] = await Promise.all([
      fetchJson(
        `${rest}/osmosis/poolmanager/v2/pools/${source.poolId}/prices?base_asset_denom=${base}&quote_asset_denom=${quote}`,
      ),
      fetchJson(
        `${rest}/osmosis/twap/v1beta1/ArithmeticTwap?pool_id=${source.poolId}&base_asset=${base}&quote_asset=${quote}&start_time=${start}&end_time=${end}`,
      ).catch(() => null),
    ]);
    return parsePoolQuote(spot, twap);
  } catch {
    return null;
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      credentials: "omit",
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await fn(items[index] as T);
    }
  }
  const workers = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return out;
}
