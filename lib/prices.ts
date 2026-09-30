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
 * `coinGeckoId` stays unpriced.
 */

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

/** Chain ids that can be priced at all, so callers can explain the gap. */
export function priceableChainIds(chainIds: readonly string[]): string[] {
  return chainIds.filter((id) => findCatalogEntry(id)?.coinGeckoId);
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
  for (const chainId of chainIds) {
    const geckoId = findCatalogEntry(chainId)?.coinGeckoId;
    if (geckoId) idsByChain.set(chainId, geckoId);
  }
  if (idsByChain.size === 0) return {};

  const cached = (await browser.storage.local.get(STORAGE_KEYS.priceCache))[
    STORAGE_KEYS.priceCache
  ] as CacheRecord | undefined;
  const fresh =
    !options.force &&
    cached &&
    cached.currency === currency &&
    Date.now() - cached.fetchedAt < CACHE_TTL_MS &&
    [...idsByChain.keys()].every((id) => cached.prices[id]);
  if (fresh && cached) return cached.prices;

  const unique = [...new Set(idsByChain.values())].sort();
  const quotes = await mapPool(unique, CONCURRENCY, (id) =>
    fetchCoinQuote(id, currency),
  );
  const byId = new Map(
    quotes.flatMap((quote) => (quote ? [[quote.id, quote] as const] : [])),
  );

  const prices: PriceMap = {};
  for (const [chainId, geckoId] of idsByChain) {
    const quote = byId.get(geckoId);
    if (!quote) continue;
    prices[chainId] = { price: quote.price, change24h: quote.change24h };
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
