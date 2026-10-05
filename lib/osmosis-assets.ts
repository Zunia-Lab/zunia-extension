/**
 * Tokens the swap lists offer as delivered on Osmosis.
 *
 * The list is the bundled token table's Osmosis rows (lib/token-identity.ts),
 * each hash-verified, verified by Osmosis and not flagged unstable, kept while
 * the SQS router that prices the swap still lists them (`/tokens/metadata`,
 * `preview: false`). SQS is a freshness filter and a decimals cross-check
 * only: its rows carry no origin (just name, symbol, decimals and a CoinGecko
 * id), so it names nothing, and on its own it offered 1,319 rows, LP shares
 * and zero-supply tokens included. What a token is comes from its identity.
 *
 * Being listed says a token exists on Osmosis, not that a route reaches it:
 * lib/xcs-routes.ts says which pairs the swap contract executes, and the
 * quote is still the binding check. The SQS listing is cached in session
 * storage so reopening the popup does not download it again.
 */

import type { LcdClient } from "@zunialab/interchain";

import { swapRouterClient } from "./interchain";
import { STORAGE_KEYS } from "./storage-keys";
import { tokenTableRows, type TokenTableRow } from "./token-identity";

/** One row SQS lists (`preview: false`), as it describes it. */
export interface OsmosisListing {
  /** Denom on Osmosis: `uosmo`, `ibc/…`, `factory/…`. */
  readonly denom: string;
  /** SQS's symbol (`USDC.noble`), an alias users have seen, never the ticker shown. */
  readonly symbol: string;
  readonly name: string;
  /** SQS's exponent, compared with the identity's; a mismatch makes the decimals unknown. */
  readonly decimals: number;
  readonly coinGeckoId: string | null;
}

/** A listed row the bundled table proves: what the swap lists offer on Osmosis. */
export interface OsmosisAsset extends OsmosisListing {
  /**
   * The table's row for the denom. Delivery to the issuer reads it: its
   * `originDenom` is the hash-verified exact spelling one hop back.
   */
  readonly row: TokenTableRow;
}

const OSMOSIS = "osmosis-1";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/**
 * Bumped when {@link CacheRecord} or {@link OsmosisListing} changes shape. A
 * stored record of another version (the 0.1.2 one had none) is ignored, so a
 * field this build reads is never silently missing from an older copy.
 */
export const OSMOSIS_ASSETS_CACHE_VERSION = 1;
const COSMOS_DENOM = /^[a-zA-Z][a-zA-Z0-9/:._-]{2,127}$/;
const MAX_SYMBOL = 24;
const MAX_NAME = 48;
const MAX_COINGECKO_ID = 64;

/**
 * One SQS row, or `null` when it does not parse. The cache is read back
 * through this too, so every field it returns survives a round trip.
 */
function toListing(denom: unknown, raw: unknown): OsmosisListing | null {
  if (typeof denom !== "string" || !COSMOS_DENOM.test(denom)) return null;
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const symbol = typeof row.symbol === "string" ? row.symbol.trim() : "";
  const decimals = row.decimals;
  if (!symbol || typeof decimals !== "number" || !Number.isInteger(decimals)) return null;
  if (decimals < 0 || decimals > 30) return null;
  const name = typeof row.name === "string" && row.name.trim() ? row.name.trim() : symbol;
  // SQS spells it `coingeckoId`; a cached row spells it as this module does.
  const rawId = typeof row.coinGeckoId === "string" ? row.coinGeckoId : row.coingeckoId;
  const coinGeckoId =
    typeof rawId === "string" && /^[a-z0-9][a-z0-9-]*$/.test(rawId.trim()) && rawId.trim().length <= MAX_COINGECKO_ID
      ? rawId.trim()
      : null;
  return {
    denom,
    symbol: symbol.slice(0, MAX_SYMBOL),
    name: name.slice(0, MAX_NAME),
    decimals,
    coinGeckoId,
  };
}

function bySymbol(a: OsmosisListing, b: OsmosisListing): number {
  return a.symbol.localeCompare(b.symbol) || a.denom.localeCompare(b.denom);
}

/**
 * Parse the router's `/tokens/metadata` body: an object keyed by denom whose
 * values carry `symbol`, `name`, `decimals`, `preview` and `coingeckoId`.
 * Unlisted rows and rows that do not parse are skipped. Sorted by symbol.
 */
export function parseOsmosisTokenMetadata(body: unknown): OsmosisListing[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const out: OsmosisListing[] = [];
  for (const [denom, raw] of Object.entries(body as Record<string, unknown>)) {
    if ((raw as { preview?: unknown } | null)?.preview !== false) continue;
    const listing = toListing(denom, raw);
    if (listing) out.push(listing);
  }
  return out.sort(bySymbol);
}

/**
 * The listed rows the bundled table proves on Osmosis and Osmosis neither
 * leaves unverified nor flags unstable, in the listing's order. This is the
 * whole Osmosis side of the To list: 106 rows on 2026-10-05, where USDC reads
 * allUSDC, USDC.n, USDC.inj and USDC.axl, and no LP share appears.
 */
export function osmosisSwapAssets(listed: readonly OsmosisListing[]): OsmosisAsset[] {
  const rows = new Map<string, TokenTableRow>();
  for (const row of tokenTableRows(OSMOSIS)) {
    if (row.verified && row.stable) rows.set(row.denom, row);
  }
  const out: OsmosisAsset[] = [];
  const seen = new Set<string>();
  for (const listing of listed) {
    const row = rows.get(listing.denom);
    if (!row || seen.has(listing.denom)) continue;
    seen.add(listing.denom);
    out.push({ ...listing, row });
  }
  return out;
}

interface CacheRecord {
  readonly version: number;
  readonly fetchedAt: number;
  readonly assets: readonly OsmosisListing[];
}

async function readCache(now: number): Promise<OsmosisListing[] | null> {
  const area = browser.storage?.session;
  if (!area) return null;
  try {
    const record = (await area.get(STORAGE_KEYS.osmosisAssets))[STORAGE_KEYS.osmosisAssets] as
      | Partial<CacheRecord>
      | undefined;
    if (!record || record.version !== OSMOSIS_ASSETS_CACHE_VERSION) return null;
    if (!Array.isArray(record.assets) || typeof record.fetchedAt !== "number") return null;
    if (record.fetchedAt > now || now - record.fetchedAt > CACHE_TTL_MS) return null;
    return record.assets
      .map((row: unknown) => toListing((row as { denom?: unknown } | null)?.denom, row))
      .filter((listing): listing is OsmosisListing => listing !== null);
  } catch {
    return null;
  }
}

async function writeCache(listed: readonly OsmosisListing[], now: number): Promise<void> {
  const area = browser.storage?.session;
  if (!area) return;
  const record: CacheRecord = { version: OSMOSIS_ASSETS_CACHE_VERSION, fetchedAt: now, assets: listed };
  await area.set({ [STORAGE_KEYS.osmosisAssets]: record }).catch(() => undefined);
}

/**
 * The Osmosis side of the To list ({@link osmosisSwapAssets}), filtered by the
 * SQS listing from the session cache when it is fresh.
 *
 * @param options.router - The SQS client; tests pass a stub.
 * @throws the router client's `InterchainError` (`reads-disabled`,
 *   `lcd-unreachable`, `aborted`) when there is no cached copy to fall back on.
 */
export async function listOsmosisAssets(
  options: { signal?: AbortSignal; router?: LcdClient; now?: number } = {},
): Promise<OsmosisAsset[]> {
  const now = options.now ?? Date.now();
  const cached = await readCache(now);
  if (cached && cached.length > 0) return osmosisSwapAssets(cached);
  const body = await (options.router ?? swapRouterClient()).getJson("/tokens/metadata", {
    timeoutMs: 15_000,
    cacheTtlMs: 0,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const listed = parseOsmosisTokenMetadata(body);
  if (listed.length > 0) await writeCache(listed, now);
  return osmosisSwapAssets(listed);
}
