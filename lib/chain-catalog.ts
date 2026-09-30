import { CHAIN_CATALOG } from "./chain-catalog.generated";

export type ChainNetwork = "mainnet" | "testnet";

/** One bank denom from a chain's `currencies` list. */
export interface CatalogCurrency {
  coinDenom: string;
  coinMinimalDenom: string;
  coinDecimals: number;
  coinGeckoId?: string;
}

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
  /**
   * Registry capability flags, e.g. `["cosmwasm"]`.
   *
   * `undefined` means the registry row publishes no list (19 of 332 do not) and
   * is deliberately different from `[]`. Nothing may read absence as support:
   * `@zunialab/interchain`'s `supportsCosmWasm` returns false for `undefined`
   * unless a caller knowingly opts in, and the NFT surface says which of the
   * two it is rather than showing an empty collection list.
   */
  features?: readonly string[];
  /**
   * Every registry currency, not only the native row above.
   *
   * Injective keeps `inj` as the native denom and lists `erc20:0x…` bank
   * denoms here. Absent on a catalog built before that field existed; callers
   * then use the native row alone.
   */
  currencies?: readonly CatalogCurrency[];
  /**
   * Protobuf type URL for an `ethsecp256k1` public key when it is not the
   * Ethermint default. Injective sets
   * `/injective.crypto.v1beta1.ethsecp256k1.PubKey`.
   */
  ethPubKeyTypeUrl?: string;
  /** Price-feed id; absent for most of the registry, which stays unpriced. */
  coinGeckoId?: string;
  rpc?: string;
  rest?: string;
  /** Bundled asset served from the extension. */
  iconPath?: string;
  /** Registry-hosted fallback. */
  iconUrl?: string;
  /** Official cosmos/chain-registry `chain_name` when this chain_id is listed. */
  registrySlug?: string;
  /**
   * True when `chainId` is in the official cosmos/chain-registry.
   * Generated rows always set this. Custom chains leave it unset.
   */
  inCosmosRegistry?: boolean;
  /**
   * Cosmostation directory names plus registry identifiers, used to resolve
   * validator moniker images. Built at catalog generate time so the logo
   * resolver does not keep a hand-maintained chain-id map.
   */
  logoSlugs?: readonly string[];
}

export { CHAIN_CATALOG };

/**
 * Chains the user added by hand. Held in memory and rehydrated from storage by
 * `custom-chains.ts` on every context boot, so lookups stay synchronous.
 */
let customEntries: readonly CatalogEntry[] = [];
/** Symbols that appear under more than one bech32 prefix. Rebuilt when custom chains change. */
let collidingSymbols: Set<string> | undefined;
/** Minimal denom to every currency that uses it. Rebuilt with the collision set. */
let currencyIndex:
  | Map<string, { entry: CatalogEntry; currency: CatalogCurrency }[]>
  | undefined;

export function setCustomCatalogEntries(entries: readonly CatalogEntry[]): void {
  customEntries = entries;
  collidingSymbols = undefined;
  currencyIndex = undefined;
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

/** Cosmostation / registry directory names for validator moniker images. */
export function catalogLogoSlugs(
  chainId: string,
): readonly string[] | undefined {
  return findCatalogEntry(chainId)?.logoSlugs;
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

/** `erc20:0xA00C…` and `peggy0xA00C…` match the registry's lowercase spelling. */
const CASE_FOLD_DENOM = /^(?:erc20:|peggy)/i;

export function denomsMatch(left: string, right: string): boolean {
  if (left === right) return true;
  if (CASE_FOLD_DENOM.test(left) && CASE_FOLD_DENOM.test(right)) {
    return left.toLowerCase() === right.toLowerCase();
  }
  return false;
}

/** Native row plus every extra currency. A catalog without `currencies` has just the native row. */
export function currenciesOf(entry: CatalogEntry): readonly CatalogCurrency[] {
  if (entry.currencies && entry.currencies.length > 0) return entry.currencies;
  return [
    {
      coinDenom: entry.coinDenom,
      coinMinimalDenom: entry.coinMinimalDenom,
      coinDecimals: entry.coinDecimals,
      ...(entry.coinGeckoId ? { coinGeckoId: entry.coinGeckoId } : {}),
    },
  ];
}

function collidingCoinDenoms(): Set<string> {
  if (collidingSymbols) return collidingSymbols;
  const prefixes = new Map<string, Set<string>>();
  for (const entry of allCatalogEntries()) {
    const seen = new Set<string>();
    for (const currency of currenciesOf(entry)) {
      if (seen.has(currency.coinDenom)) continue;
      seen.add(currency.coinDenom);
      const set = prefixes.get(currency.coinDenom) ?? new Set<string>();
      set.add(entry.bech32Prefix);
      prefixes.set(currency.coinDenom, set);
    }
  }
  collidingSymbols = new Set(
    [...prefixes.entries()].filter(([, set]) => set.size > 1).map(([symbol]) => symbol),
  );
  return collidingSymbols;
}

/**
 * `USDC.inj` when that ticker is issued on more than one prefix.
 * `wINJ` stays `wINJ` because only the `inj` prefix uses it.
 */
export function displayCoinSymbol(symbol: string, bech32Prefix: string): string {
  if (!symbol || !collidingCoinDenoms().has(symbol)) return symbol;
  return `${symbol}.${bech32Prefix}`;
}

/** The chain's staking ticker, with a prefix suffix when that ticker is shared. */
export function chainTicker(entry: {
  coinDenom: string;
  bech32Prefix: string;
}): string {
  return displayCoinSymbol(entry.coinDenom, entry.bech32Prefix);
}

/** The fee ticker, with the same suffix rule as {@link chainTicker}. */
export function feeTicker(entry: {
  feeDenom: string;
  coinDenom: string;
  bech32Prefix: string;
}): string {
  return displayCoinSymbol(entry.feeDenom || entry.coinDenom, entry.bech32Prefix);
}

export function chainUsesEthKeySign(chainId: string): boolean {
  return findCatalogEntry(chainId)?.features?.includes("eth-key-sign") === true;
}

export function ethPubKeyTypeUrlFor(chainId: string): string | undefined {
  const url = findCatalogEntry(chainId)?.ethPubKeyTypeUrl?.trim();
  return url ? url : undefined;
}

function denomIndexKey(denom: string): string {
  return CASE_FOLD_DENOM.test(denom) ? denom.toLowerCase() : denom;
}

function indexedCurrencies(): Map<
  string,
  { entry: CatalogEntry; currency: CatalogCurrency }[]
> {
  if (currencyIndex) return currencyIndex;
  const index = new Map<string, { entry: CatalogEntry; currency: CatalogCurrency }[]>();
  for (const entry of allCatalogEntries()) {
    for (const currency of currenciesOf(entry)) {
      const key = denomIndexKey(currency.coinMinimalDenom);
      const list = index.get(key);
      if (list) list.push({ entry, currency });
      else index.set(key, [{ entry, currency }]);
    }
  }
  currencyIndex = index;
  return index;
}

/** A currency row whose minimal denom is `denom`, preferring a mainnet issuer. */
export function findCurrency(
  denom: string,
): { entry: CatalogEntry; currency: CatalogCurrency } | undefined {
  const needle = denom.trim();
  if (!needle) return undefined;
  const matches = indexedCurrencies().get(denomIndexKey(needle));
  if (!matches || matches.length === 0) return undefined;
  return matches.find((match) => match.entry.network === "mainnet") ?? matches[0];
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
    entry.coinDenom.toLowerCase().includes(q) ||
    (entry.registrySlug?.toLowerCase().includes(q) ?? false)
  );
}
