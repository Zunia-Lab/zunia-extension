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
 * `coinGeckoId` stays unpriced, unless config/prices.ts names one exchange
 * market for it (SAF on Coinstore): that price carries its `source`.
 */

import { EXCHANGE_PRICE_SOURCES, type ExchangePriceSource } from "../config/prices";
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
   * Set when the price comes from one exchange market rather than CoinGecko's
   * aggregate, so every surface can say where it comes from.
   */
  source?: { name: string; pair: string; url: string };
}

/** Prices keyed by chain id. */
export type PriceMap = Record<string, SpotPrice>;

const COIN_ENDPOINT = "https://api.coingecko.com/api/v3/coins/";
/** Coinstore's public candles: 24 hourly bars give the last price and the 24h change in one small read. */
const COINSTORE_KLINE_ENDPOINT = "https://api.coinstore.com/api/v1/market/kline/";
/** CoinGecko's id for USDT, the quote currency of the exchange markets. */
const TETHER_ID = "tether";
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

/** The exchange market a chain is priced from, when it has no CoinGecko id. */
export function exchangeSourceFor(
  chainId: string,
  sources: Readonly<Record<string, ExchangePriceSource>> = EXCHANGE_PRICE_SOURCES,
): ExchangePriceSource | null {
  if (findCatalogEntry(chainId)?.coinGeckoId) return null;
  return sources[chainId] ?? null;
}

/** Chain ids that can be priced at all, so callers can explain the gap. */
export function priceableChainIds(chainIds: readonly string[]): string[] {
  return chainIds.filter((id) => findCatalogEntry(id)?.coinGeckoId || exchangeSourceFor(id));
}

/**
 * Last price and 24h change from Coinstore's hourly candles, in the market's
 * quote currency: the newest close, against the open of the oldest of the
 * last 24 bars. Null for anything it cannot read whole.
 */
export function parseCoinstoreKlines(body: unknown): { price: number; change24h: number } | null {
  const items = (body as { data?: { item?: unknown } } | null)?.data?.item;
  if (!Array.isArray(items) || items.length === 0) return null;
  const bars: Array<{ start: number; open: number; close: number }> = [];
  for (const raw of items) {
    const row = raw as { startTime?: unknown; open?: unknown; close?: unknown } | null;
    const start = Number(row?.startTime);
    const open = Number(row?.open);
    const close = Number(row?.close);
    if (!Number.isFinite(start) || !(open > 0) || !(close > 0)) return null;
    bars.push({ start, open, close });
  }
  bars.sort((a, b) => a.start - b.start);
  const window = bars.slice(-24);
  const first = window[0]!;
  const last = window[window.length - 1]!;
  return { price: last.close, change24h: ((last.close - first.open) / first.open) * 100 };
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
  const exchangeChains = new Map<string, ExchangePriceSource>();
  for (const chainId of chainIds) {
    const geckoId = findCatalogEntry(chainId)?.coinGeckoId;
    if (geckoId) idsByChain.set(chainId, geckoId);
    const source = exchangeSourceFor(chainId);
    if (source) exchangeChains.set(chainId, source);
  }
  if (idsByChain.size === 0 && exchangeChains.size === 0) return {};

  const cached = (await browser.storage.local.get(STORAGE_KEYS.priceCache))[
    STORAGE_KEYS.priceCache
  ] as CacheRecord | undefined;
  const fresh =
    !options.force &&
    cached &&
    cached.currency === currency &&
    Date.now() - cached.fetchedAt < CACHE_TTL_MS &&
    [...idsByChain.keys(), ...exchangeChains.keys()].every((id) => cached.prices[id]);
  if (fresh && cached) return cached.prices;

  // Tether too when an exchange market needs converting from USDT.
  const unique = [
    ...new Set([...idsByChain.values(), ...(exchangeChains.size > 0 ? [TETHER_ID] : [])]),
  ].sort();
  const [quotes, markets] = await Promise.all([
    mapPool(unique, CONCURRENCY, (id) => fetchCoinQuote(id, currency)),
    mapPool([...exchangeChains.entries()], CONCURRENCY, async ([chainId, source]) => ({
      chainId,
      source,
      quote: await fetchExchangeQuote(source),
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
  // USDT in the user's currency; without a Tether quote only USD can assume par.
  const usdt = byId.get(TETHER_ID)?.price ?? (currency === "usd" ? 1 : null);
  for (const { chainId, source, quote } of markets) {
    if (!quote || usdt === null) continue;
    prices[chainId] = {
      price: quote.price * usdt,
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

async function fetchExchangeQuote(
  source: ExchangePriceSource,
): Promise<{ price: number; change24h: number } | null> {
  if (source.exchange !== "coinstore") return null;
  try {
    const url = `${COINSTORE_KLINE_ENDPOINT}${encodeURIComponent(source.market)}?period=60min&size=24`;
    return parseCoinstoreKlines(await fetchJson(url));
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
