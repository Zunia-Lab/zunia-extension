import { CHAIN_CATALOG } from "./chain-catalog.generated";

export type ChainNetwork = "mainnet" | "testnet";

/** Flat registry row emitted by scripts/generate-chain-catalog.mjs. */
export interface CatalogEntry {
  chainId: string;
  chainName: string;
  bech32Prefix: string;
  coinType: number;
  network: ChainNetwork;
  coinDenom: string;
  coinMinimalDenom: string;
  coinDecimals: number;
  feeDenom: string;
  feeMinimalDenom: string;
  feeDecimals: number;
  gasPriceStep?: { low: number; average: number; high: number };
  /** Price-feed id; absent for most of the registry, which stays unpriced. */
  coinGeckoId?: string;
  rpc?: string;
  rest?: string;
  /** Bundled asset served from the extension. */
  iconPath?: string;
  /** Registry-hosted fallback. */
  iconUrl?: string;
}

export { CHAIN_CATALOG };

/**
 * Chains the user added by hand. Held in memory and rehydrated from storage by
 * `custom-chains.ts` on every context boot, so lookups stay synchronous.
 */
let customEntries: readonly CatalogEntry[] = [];

export function setCustomCatalogEntries(entries: readonly CatalogEntry[]): void {
  customEntries = entries;
}

export function getCustomCatalogEntries(): readonly CatalogEntry[] {
  return customEntries;
}

/** Registry rows plus anything the user added manually. */
export function allCatalogEntries(): CatalogEntry[] {
  return [...CHAIN_CATALOG, ...customEntries];
}

/** Chains pinned to the top of every picker, in this order. */
export const PINNED_CHAIN_IDS = [
  "safrochain-1",
  "cosmoshub-4",
  "osmosis-1",
] as const;

const PINNED_RANK = new Map<string, number>(
  PINNED_CHAIN_IDS.map((id, i) => [id, i]),
);

/** Pinned first, then mainnets before testnets, then alphabetical. */
export function sortCatalog(
  entries: readonly CatalogEntry[],
): CatalogEntry[] {
  return [...entries].sort((a, b) => {
    const ra = PINNED_RANK.get(a.chainId) ?? Number.MAX_SAFE_INTEGER;
    const rb = PINNED_RANK.get(b.chainId) ?? Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    if (a.network !== b.network) return a.network === "mainnet" ? -1 : 1;
    return a.chainName.localeCompare(b.chainName);
  });
}

export function isPinnedChain(chainId: string): boolean {
  return PINNED_RANK.has(chainId);
}

export function catalogIconFor(entry: CatalogEntry): string | undefined {
  return entry.iconPath ?? entry.iconUrl;
}

export function findCatalogEntry(chainId: string): CatalogEntry | undefined {
  return (
    customEntries.find((c) => c.chainId === chainId) ??
    CHAIN_CATALOG.find((c) => c.chainId === chainId)
  );
}

/**
 * Find a registry row by base denom (e.g. `uusdc`, `uatom`). Prefers mainnet
 * when several chains advertise the same minimal denom.
 */
export function findCatalogByMinimalDenom(
  minimalDenom: string,
): CatalogEntry | undefined {
  const needle = minimalDenom.trim().toLowerCase();
  if (!needle) return undefined;
  const matches = allCatalogEntries().filter(
    (entry) =>
      entry.coinMinimalDenom.toLowerCase() === needle ||
      entry.feeMinimalDenom.toLowerCase() === needle,
  );
  if (matches.length === 0) return undefined;
  return (
    matches.find((entry) => entry.network === "mainnet") ?? matches[0]
  );
}

/** Case-insensitive match on name, chain id, prefix, or denom. */
export function matchesChainQuery(
  entry: CatalogEntry,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    entry.chainName.toLowerCase().includes(q) ||
    entry.chainId.toLowerCase().includes(q) ||
    entry.bech32Prefix.toLowerCase().includes(q) ||
    entry.coinDenom.toLowerCase().includes(q)
  );
}
