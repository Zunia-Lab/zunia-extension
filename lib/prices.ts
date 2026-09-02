/**
 * Optional spot prices.
 *
 * Shares the live-reads opt-in with `balances.ts`: without the host permission
 * every call short-circuits and the UI keeps showing an em dash rather than a
 * number it cannot justify. Only chains whose registry entry carries a
 * `coinGeckoId` can be priced, so a portfolio total is always reported
 * alongside the number of chains it actually covers.
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

const ENDPOINT = "https://api.coingecko.com/api/v3/simple/price";
const CACHE_TTL_MS = 120_000;
const REQUEST_TIMEOUT_MS = 8_000;

interface CacheRecord {
  fetchedAt: number;
  currency: string;
  prices: PriceMap;
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
  const url =
    `${ENDPOINT}?ids=${encodeURIComponent(unique.join(","))}` +
    `&vs_currencies=${currency}&include_24hr_change=true`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let body: Record<string, Record<string, number>>;
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      credentials: "omit",
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = (await res.json()) as Record<string, Record<string, number>>;
  } catch {
    // Rate limits and offline states are expected; keep the last good page.
    return cached?.currency === currency ? cached.prices : {};
  } finally {
    clearTimeout(timer);
  }

  const prices: PriceMap = {};
  for (const [chainId, geckoId] of idsByChain) {
    const row = body[geckoId];
    const price = row?.[currency];
    if (typeof price !== "number") continue;
    prices[chainId] = {
      price,
      change24h: row[`${currency}_24h_change`] ?? 0,
    };
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
