import { CHAIN_CATALOG } from "./chain-catalog.generated";
import { catalogTicker } from "./token-identity";

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
/** Minimal denom to every currency that uses it. Rebuilt when custom chains change. */
let currencyIndex:
  | Map<string, { entry: CatalogEntry; currency: CatalogCurrency }[]>
  | undefined;

export function setCustomCatalogEntries(entries: readonly CatalogEntry[]): void {
  customEntries = entries;
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
 *
 * @deprecated Never use it to name or price a token: `uusdc` is issued by
 * Noble and Axelar alike and this returns whichever the catalog lists first.
 * Use `identityOf` (lib/token-identity.ts), or {@link uniqueIssuerOf} when
 * only a base denom is known. Kept so callers migrate one at a time.
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

/**
 * The ticker a currency named `symbol` on a chain with `bech32Prefix` reads as.
 *
 * @deprecated A symbol and a prefix do not identify a token: `terra` is both
 * Terra and Terra Classic, and the old rule suffixed every issuer of a shared
 * symbol, the home one included (`ATOM.cosmos`). This now finds the mainnet
 * currency and applies the identity rule (`USDC` on `noble` reads `USDC.n`,
 * `ATOM` on `cosmos` reads `ATOM`); use `identityOf` for a held denom.
 */
export function displayCoinSymbol(symbol: string, bech32Prefix: string): string {
  if (!symbol) return symbol;
  for (const entry of CHAIN_CATALOG) {
    if (entry.bech32Prefix !== bech32Prefix || entry.network !== "mainnet") continue;
    const currency = currenciesOf(entry).find((row) => row.coinDenom === symbol);
    if (currency) return catalogTicker(entry, currency);
  }
  return symbol;
}

/** The parts of a catalog row the ticker rule reads. */
type TickerChain = {
  chainId?: string;
  coinDenom: string;
  coinMinimalDenom?: string;
  bech32Prefix: string;
};

/**
 * The chain's staking ticker under the identity rule: `ATOM` on the Hub, `AXL`
 * on Axelar, `USDC.n` on Noble. Testnets and chains the user added are never
 * issuers, so they read as the bare symbol and cannot rename anyone else's.
 */
export function chainTicker(entry: TickerChain): string {
  return tickerOfCurrency(entry, entry.coinDenom, entry.coinMinimalDenom);
}

/** The fee ticker, with the same rule as {@link chainTicker}. */
export function feeTicker(
  entry: TickerChain & { feeDenom: string; feeMinimalDenom?: string },
): string {
  if (!entry.feeDenom || entry.feeDenom === entry.coinDenom) return chainTicker(entry);
  return tickerOfCurrency(entry, entry.feeDenom, entry.feeMinimalDenom);
}

function tickerOfCurrency(entry: TickerChain, symbol: string, minimalDenom?: string): string {
  const row = entry.chainId ? findCatalogEntry(entry.chainId) : undefined;
  if (!row) return symbol;
  const currency =
    (minimalDenom ? findCurrencyOn(row.chainId, minimalDenom)?.currency : undefined) ??
    currenciesOf(row).find((candidate) => candidate.coinDenom === symbol) ?? {
      coinDenom: symbol,
      coinMinimalDenom: minimalDenom ?? row.coinMinimalDenom,
      coinDecimals: row.coinDecimals,
    };
  return catalogTicker(row, currency);
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

/**
 * A currency row whose minimal denom is `denom`, preferring a mainnet issuer.
 *
 * @deprecated Global first match: `uusdc` resolves to Axelar even for Noble
 * USDC. Use {@link findCurrencyOn} with the chain that holds the denom, or
 * `identityOf` (lib/token-identity.ts) to name a token. Kept so callers
 * migrate one at a time.
 */
export function findCurrency(
  denom: string,
): { entry: CatalogEntry; currency: CatalogCurrency } | undefined {
  const needle = denom.trim();
  if (!needle) return undefined;
  const matches = indexedCurrencies().get(denomIndexKey(needle));
  if (!matches || matches.length === 0) return undefined;
  return matches.find((match) => match.entry.network === "mainnet") ?? matches[0];
}

/**
 * The currency `denom` is on `chainId` itself, or `undefined`.
 *
 * Only `erc20:` and `peggy` denoms compare without case: the catalog spells
 * Injective's erc20 rows in lowercase while the bank uses mixed case. Every
 * other denom must match exactly. This is for naming only; never build a
 * message denom from the row it returns.
 */
export function findCurrencyOn(
  chainId: string,
  denom: string,
): { entry: CatalogEntry; currency: CatalogCurrency } | undefined {
  const entry = findCatalogEntry(chainId);
  if (!entry || !denom) return undefined;
  const currency = currenciesOf(entry).find((row) => denomsMatch(row.coinMinimalDenom, denom));
  if (currency) return { entry, currency };
  // A few registry rows list a staking or fee coin only in its own fields.
  if (denom === entry.coinMinimalDenom) {
    return {
      entry,
      currency: {
        coinDenom: entry.coinDenom,
        coinMinimalDenom: entry.coinMinimalDenom,
        coinDecimals: entry.coinDecimals,
        ...(entry.coinGeckoId ? { coinGeckoId: entry.coinGeckoId } : {}),
      },
    };
  }
  if (denom === entry.feeMinimalDenom) {
    return {
      entry,
      currency: {
        coinDenom: entry.feeDenom,
        coinMinimalDenom: entry.feeMinimalDenom,
        coinDecimals: entry.feeDecimals,
      },
    };
  }
  return undefined;
}

/**
 * Base units that Ethereum, Bitcoin and Solana assets unwind to. A catalog
 * chain that happens to call its own coin `wei` (Stratos) is not the issuer of
 * the Ethereum ETH that Picasso carries, so these never have a unique issuer.
 */
const FOREIGN_BASE_UNITS: ReadonlySet<string> = new Set([
  "wei",
  "gwei",
  "sat",
  "sats",
  "satoshi",
  "lamport",
  "lamports",
]);

/**
 * The one mainnet registry chain that issues `baseDenom`, or `undefined` when
 * none does or several do (`uusdc`: Noble, Axelar and others).
 *
 * The only safe base-denom lookup: it never picks between issuers. Custom
 * chains and testnets do not count, so a chain the user adds cannot capture a
 * denom, and non-Cosmos base units (`wei`) never resolve to a Cosmos chain.
 */
export function uniqueIssuerOf(
  baseDenom: string,
): { entry: CatalogEntry; currency: CatalogCurrency } | undefined {
  const needle = baseDenom.trim();
  if (!needle || FOREIGN_BASE_UNITS.has(needle.toLowerCase())) return undefined;
  const custom = new Set(customEntries.map((entry) => entry.chainId));
  const issuers = (indexedCurrencies().get(denomIndexKey(needle)) ?? []).filter(
    (match) => match.entry.network === "mainnet" && !custom.has(match.entry.chainId),
  );
  const chains = new Set(issuers.map((match) => match.entry.chainId));
  return chains.size === 1 ? issuers[0] : undefined;
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
