/**
 * Tokens Osmosis lists as tradeable, for the receive side of a swap.
 *
 * The list comes from the same SQS router that prices the swap
 * (`/tokens/metadata`), keeps only listed tokens (`preview: false`), and is
 * cached in session storage so reopening the popup does not download it again.
 * Being listed says a token exists on Osmosis, not that a pool reaches it from
 * the token being sold: the quote is what proves a pair, and a token with no
 * route says so on the quote panel.
 */

import { swapRouterClient } from "./interchain";
import { STORAGE_KEYS } from "./storage-keys";

export interface OsmosisAsset {
  /** Denom on Osmosis: `uosmo`, `ibc/…`, `factory/…`. */
  readonly denom: string;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const COSMOS_DENOM = /^[a-zA-Z][a-zA-Z0-9/:._-]{2,127}$/;
const MAX_SYMBOL = 24;
const MAX_NAME = 48;

function toAsset(denom: unknown, raw: unknown): OsmosisAsset | null {
  if (typeof denom !== "string" || !COSMOS_DENOM.test(denom)) return null;
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const symbol = typeof row.symbol === "string" ? row.symbol.trim() : "";
  const decimals = row.decimals;
  if (!symbol || typeof decimals !== "number" || !Number.isInteger(decimals)) return null;
  if (decimals < 0 || decimals > 30) return null;
  const name = typeof row.name === "string" && row.name.trim() ? row.name.trim() : symbol;
  return {
    denom,
    symbol: symbol.slice(0, MAX_SYMBOL),
    name: name.slice(0, MAX_NAME),
    decimals,
  };
}

function bySymbol(a: OsmosisAsset, b: OsmosisAsset): number {
  return a.symbol.localeCompare(b.symbol) || a.denom.localeCompare(b.denom);
}

/**
 * Parse the router's `/tokens/metadata` body: an object keyed by denom whose
 * values carry `symbol`, `name`, `decimals` and `preview`. Unlisted rows and
 * rows that do not parse are skipped. Sorted by symbol.
 */
export function parseOsmosisTokenMetadata(body: unknown): OsmosisAsset[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const out: OsmosisAsset[] = [];
  for (const [denom, raw] of Object.entries(body as Record<string, unknown>)) {
    if ((raw as { preview?: unknown } | null)?.preview !== false) continue;
    const asset = toAsset(denom, raw);
    if (asset) out.push(asset);
  }
  return out.sort(bySymbol);
}

interface CacheRecord {
  readonly fetchedAt: number;
  readonly assets: readonly OsmosisAsset[];
}

async function readCache(now: number): Promise<OsmosisAsset[] | null> {
  const area = browser.storage?.session;
  if (!area) return null;
  try {
    const record = (await area.get(STORAGE_KEYS.osmosisAssets))[STORAGE_KEYS.osmosisAssets] as
      | Partial<CacheRecord>
      | undefined;
    if (!record || !Array.isArray(record.assets) || typeof record.fetchedAt !== "number") {
      return null;
    }
    if (now - record.fetchedAt > CACHE_TTL_MS) return null;
    return record.assets
      .map((row: unknown) => toAsset((row as { denom?: unknown } | null)?.denom, row))
      .filter((asset): asset is OsmosisAsset => asset !== null);
  } catch {
    return null;
  }
}

async function writeCache(assets: readonly OsmosisAsset[], now: number): Promise<void> {
  const area = browser.storage?.session;
  if (!area) return;
  const record: CacheRecord = { fetchedAt: now, assets };
  await area.set({ [STORAGE_KEYS.osmosisAssets]: record }).catch(() => undefined);
}

/**
 * Listed Osmosis tokens, from the session cache when it is fresh.
 *
 * @throws the router client's `InterchainError` (`reads-disabled`,
 *   `lcd-unreachable`, `aborted`) when there is no cached copy to fall back on.
 */
export async function listOsmosisAssets(
  options: { signal?: AbortSignal } = {},
): Promise<OsmosisAsset[]> {
  const now = Date.now();
  const cached = await readCache(now);
  if (cached && cached.length > 0) return cached;
  const body = await swapRouterClient().getJson("/tokens/metadata", {
    timeoutMs: 15_000,
    cacheTtlMs: 0,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const assets = parseOsmosisTokenMetadata(body);
  if (assets.length > 0) await writeCache(assets, now);
  return assets;
}
