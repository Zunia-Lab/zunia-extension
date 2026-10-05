/**
 * Token identity: the one place a bank denom becomes a name.
 *
 * Every surface (Home, Send, Swap, history, approvals, notices, the memo)
 * reads a {@link TokenIdentity} from here instead of turning a denom into text
 * on its own. Two facts drive the design:
 *
 * 1. An `ibc/HASH` denom names a path, not a token. The same `uusdc` base is
 *    Noble USDC over Osmosis channel-750 and Axelar USDC over channel-208, so
 *    the issuer comes from the trace, never from "the first catalog chain that
 *    lists the base denom". The generated table
 *    (scripts/generate-token-registry.mjs) and the engine's channel walk are
 *    the only two sources, and both prove the trace hashes to the denom.
 * 2. The ticker names the origin and never the location. `USDC.n` is Noble's
 *    USDC on Noble, Osmosis and Injective alike; where it sits is a separate
 *    field (`heldOnChainId`) that the UI shows as a badge and an "on X" line.
 *
 * Display only. Nothing here may feed a signed message: message denoms come
 * from the bank or from the table's hash-verified `originDenom`, never from a
 * ticker and never from the catalog's lowercased erc20 spellings.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { InterchainError, isInterchainError } from "@zunialab/interchain";

import {
  CHAIN_CATALOG,
  currenciesOf,
  findCatalogEntry,
  findCurrencyOn,
  getCustomCatalogEntries,
  type CatalogCurrency,
  type CatalogEntry,
} from "./chain-catalog";
import { shortDenom } from "./format";
import { IBC_CHANNEL_ROWS } from "./ibc-channels.generated";
import { denomResolver } from "./interchain";
import { STORAGE_KEYS } from "./storage-keys";
import {
  CATALOG_LOGOS,
  TOKEN_CHAINS,
  TOKEN_GROUPS,
  TOKEN_LOGO_PREFIXES,
  TOKEN_LOGOS,
  TOKEN_ROWS,
  type TokenRowTuple,
} from "./token-registry.generated";

/* -------------------------------------------------------------------------- *
 * Public types
 * -------------------------------------------------------------------------- */

/**
 * How a denom is minted on the chain that holds it. `native` is the chain's
 * staking or fee coin only; any other plain bank denom is `other`, so nothing
 * that prices "native" coins by the holding chain can price stATOM as STRD.
 */
export type TokenKind = "native" | "ibc" | "factory" | "erc20" | "peggy" | "cw20" | "other";

/**
 * How the origin was established.
 * - `native`: minted on the chain that holds it (a staking coin, a factory or
 *   erc20 denom), so the holding chain is the origin by construction.
 * - `catalog`: a currency the bundled catalog lists on the holding chain.
 * - `table`: a voucher in the generated, hash-verified token table.
 * - `channel-walk`: a voucher whose trace the engine fetched, hash-checked and
 *   walked channel by channel to its origin chain. Proven only when every hop
 *   travelled over a channel the chain registry names as canonical: a walk
 *   believes each light client's claimed chain id, and a look-alike chain can
 *   claim to be `noble-1` over a channel of its own.
 * - `unknown`: none of the above. Never guessed.
 */
export type TokenProvenance = "native" | "catalog" | "table" | "channel-walk" | "unknown";

/** Bridge that carried a token into Cosmos, as its ticker tag. */
export type TokenBridge =
  | "axl"
  | "grv"
  | "wh"
  | "peggy"
  | "eureka"
  | "pica"
  | "rt"
  | "carbon"
  | "int3"
  | "thor";

/** Network a bridge carried a token from, when it is not Ethereum. */
export type SourceNetwork = "polygon" | "avax" | "arb" | "op" | "base" | "sol" | "bsc" | "tron";

/**
 * Where a token text is shown, see {@link tokenText}.
 * - `pill`: the second line of a token pill, `on Osmosis`.
 * - `row`: a list row's subtitle, `Noble USDC · on Osmosis`.
 * - `sentence`: inline prose, `USDC.n (Noble USDC) on Osmosis`.
 * - `a11y`: the accessible name, `USDC from Noble, on Osmosis`.
 */
export type TokenTextVariant = "pill" | "row" | "sentence" | "a11y";

/** What a token is and where it is. Display only: nothing here is ever signed. */
export interface TokenIdentity {
  /** `${heldOnChainId}:${denom}`, the same key as picker memory and swap options. */
  readonly key: string;
  /** Where the balance lives, or where a destination is delivered. */
  readonly heldOnChainId: string;
  /** The holding chain's display name ("Osmosis"), or its id when unknown. */
  readonly heldOnChainName: string;
  /** The exact bank denom, never case-folded. */
  readonly denom: string;
  readonly kind: TokenKind;
  /** The issuer chain, or `null` when it cannot be proven. */
  readonly originChainId: string | null;
  readonly originChainName: string | null;
  /**
   * The exact denom on the origin chain: from a hash-verified trace or the
   * table's source denom, never from the catalog's case-folded spelling.
   */
  readonly originDenom: string | null;
  /** IBC trace path on the holding chain (`transfer/channel-750`), `""` when none. */
  readonly path: string;
  /** Chain reached after each hop of `path`, same order; `null` where unknown. */
  readonly hopChainIds: readonly (string | null)[];
  readonly bridge: TokenBridge | null;
  readonly sourceNetwork: SourceNetwork | null;
  /** The asset without its issuer decorations: `USDC` for USDC.n and USDC.axl. */
  readonly family: string;
  /** `USDC.inj`, `ATOM`, `allUSDC`; `IBC·498A` when the origin is unknown. */
  readonly ticker: string;
  /** `Injective USDC`, `Alloyed USDC`, `Unknown token`. */
  readonly name: string;
  /** Display exponent; 0 when unknown, in which case amounts are base units. */
  readonly decimals: number;
  readonly decimalsKnown: boolean;
  /** A token logo. Never a chain logo for a token that is not that chain's coin. */
  readonly logoUrl: string | null;
  readonly coinGeckoId: string | null;
  /** Osmosis variant group (the alloy's denom), shared by every USDC variant. */
  readonly variantGroup: string | null;
  /** An Osmosis alloy (transmuter share), shown as `all` + family. */
  readonly alloyed: boolean;
  /** This asset's denom on osmosis-1: the held denom there, else the canonical voucher. */
  readonly osmosisDenom: string | null;
  /** Other names users have seen: SQS (`USDC.noble`), registry (`USDC.n`), legacy (`axlUSDC`). */
  readonly aliases: readonly string[];
  readonly provenance: TokenProvenance;
  /**
   * Origin and name both come from the registry, the table or a verified
   * channel walk. The only reason a seal or a "verified" line may be shown.
   */
  readonly proven: boolean;
  /** Held on a testnet or a chain the user added; never an issuer, shown with a pill. */
  readonly testnet: boolean;
}

/** What {@link tickerFor} needs to name an asset. */
export interface TickerInput {
  readonly family: string;
  readonly originChainId: string | null;
  readonly bridge?: TokenBridge | null;
  readonly sourceNetwork?: SourceNetwork | null;
  readonly alloyed?: boolean;
}

/** One decoded row of the generated table. */
export interface TokenTableRow {
  readonly heldOnChainId: string;
  /** Bank denom on the holding chain (`ibc/` hashes uppercase). */
  readonly denom: string;
  /**
   * The issuer as the source lists it. On a multi-hop Osmosis row that is the
   * chain one hop back, which may only have relayed the token (Osmosis lists
   * LBTC as the Hub's); {@link identityOf} then names the further issuer when
   * the table holds the relay's row, so read names from the identity.
   */
  readonly originChainId: string;
  /**
   * The issuer's exact, hash-verified denom (`erc20:0xa00C…`), equal to
   * `denom` when the holding chain is the issuer (an Osmosis alloy, a hub's
   * Eureka voucher). Only when `counterpartyChainId === originChainId` is it
   * the denom one hop back, so that unwinding over `channelId` delivers it on
   * the issuer; every Osmosis voucher row is of that kind. A hub row with
   * more hops may name its ultimate base instead, and then the two chain ids
   * differ. Never rebuild it from the catalog, whose erc20 spellings are
   * lowercase.
   */
  readonly originDenom: string;
  /** Trace path on the holding chain, `""` for a local denom. */
  readonly path: string;
  /** The trace's base denom (`wei` for Picasso ETH); equals originDenom for one hop. */
  readonly baseDenom: string;
  /** First hop's channel on the holding chain (`channel-122`); `null` for a light-client hop. */
  readonly channelId: string | null;
  /** Chain at the other end of `channelId`; `null` when there is no channel hop. */
  readonly counterpartyChainId: string | null;
  /** The same channel's id on that chain (`channel-8`). */
  readonly counterpartyChannelId: string | null;
  readonly family: string;
  readonly bridge: TokenBridge | null;
  readonly sourceNetwork: SourceNetwork | null;
  readonly alloyed: boolean;
  /** Osmosis lists the row as verified (every hub-chain row counts as verified). */
  readonly verified: boolean;
  /** Not flagged unstable or disabled by Osmosis. */
  readonly stable: boolean;
  readonly decimals: number;
  readonly logoUrl: string | null;
  readonly coinGeckoId: string | null;
  readonly variantGroup: string | null;
  readonly aliases: readonly string[];
}

/**
 * The part of the engine's denom resolver {@link identifyHeld} uses. Results
 * must be hash-checked traces; this module re-checks them anyway.
 */
export interface DenomTraceResolver {
  identifyDenoms(
    chainId: string,
    denoms: readonly string[],
    options?: { signal?: AbortSignal; bulkThreshold?: number; maxLookups?: number },
  ): Promise<
    ReadonlyMap<
      string,
      {
        readonly baseDenom: string;
        readonly path: string;
        readonly originChainId: string | null;
        readonly hopChainIds?: readonly (string | null)[];
      }
    >
  >;
}

export interface IdentifyHeldOptions {
  readonly signal?: AbortSignal;
  /** Defaults to the engine's resolver (lib/interchain.ts). Tests pass a stub. */
  readonly resolver?: DenomTraceResolver;
}

/** The single short form of a denom; implemented in format.ts so it stays a leaf. */
export { shortDenom };

/* -------------------------------------------------------------------------- *
 * The ticker rule
 * -------------------------------------------------------------------------- */

/** The venue chain the table's Osmosis rows describe. */
const OSMOSIS = "osmosis-1";

/** Families with several issuers of equal standing: always tagged, never bare. */
const MULTI_ISSUER: ReadonlySet<string> = new Set(["USDC", "USDT", "DAI", "ETH", "WBTC", "BTC"]);

/**
 * Issuer tags the ecosystem already uses (chain-registry #7918, Keplr, Skip).
 * Any other issuer falls back to its bech32 prefix, as Osmosis does.
 */
const ISSUER_TAG: ReadonlyMap<string, string> = new Map([
  ["noble-1", "n"],
  ["injective-1", "inj"],
  ["kava_2222-10", "kava"],
  ["osmosis-1", "osmo"],
]);

/** Ticker suffixes that decorate a family rather than name it (`USDC.e.matic.axl`). */
const DECORATIONS: ReadonlySet<string> = new Set([
  "n", "inj", "axl", "grv", "wh", "peggy", "pica", "eureka", "kava", "osmo", "noble", "atom",
  "eth", "sol", "avax", "matic", "polygon", "arb", "op", "base", "bsc", "tron", "rt", "int3",
  "carbon", "terra", "e", "gravity", "wormhole", "axelar", "cosmos",
]);

/** Keplr-style network prefixes on Axelar tickers (`PolygonUSDC.axl`). */
const NETWORK_PREFIX: ReadonlyMap<string, SourceNetwork> = new Map([
  ["Polygon", "polygon"],
  ["Avalanche", "avax"],
  ["Arbitrum", "arb"],
  ["Optimism", "op"],
  ["Base", "base"],
  ["Binance", "bsc"],
]);

/** Every bridge tag; a catalog symbol may already carry one (`LINK.axl`). */
const BRIDGES: ReadonlySet<TokenBridge> = new Set<TokenBridge>([
  "axl", "grv", "wh", "peggy", "eureka", "pica", "rt", "carbon", "int3", "thor",
]);
const NETWORKS: ReadonlySet<SourceNetwork> = new Set<SourceNetwork>([
  "polygon", "avax", "arb", "op", "base", "sol", "bsc", "tron",
]);
const isBridge = (value: string): value is TokenBridge => BRIDGES.has(value as TokenBridge);
const isNetwork = (value: string): value is SourceNetwork => NETWORKS.has(value as SourceNetwork);

/**
 * THORChain pool assets are `chain-asset[-contract]` (`eth-usdc-0xa0b8…`). The
 * first part is the network the asset lives on.
 */
const THOR_POOL = /^(eth|avax|base|bsc|tron|gaia|btc|bch|doge|ltc|xrp|sol)-/;
const THOR_NETWORK: ReadonlyMap<string, SourceNetwork> = new Map([
  ["avax", "avax"],
  ["base", "base"],
  ["bsc", "bsc"],
  ["tron", "tron"],
  ["sol", "sol"],
]);

const NETWORK_NAME: Readonly<Record<SourceNetwork, string>> = {
  polygon: "Polygon",
  avax: "Avalanche",
  arb: "Arbitrum",
  op: "Optimism",
  base: "Base",
  sol: "Solana",
  bsc: "BNB Chain",
  tron: "Tron",
};

/**
 * Ethereum contracts behind the Peggy (`peggy0x…`) and Gravity (`gravity0x…`)
 * denoms the catalog does not list, such as Injective's legacy Peggy USDC.
 * The denom embeds the contract, so the asset is known without a registry row.
 */
const ETHEREUM_TOKENS: ReadonlyMap<string, readonly [string, number]> = new Map([
  ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", ["USDC", 6]],
  ["0xdac17f958d2ee523a2206206994597c13d831ec7", ["USDT", 6]],
  ["0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", ["ETH", 18]],
  ["0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", ["WBTC", 8]],
  ["0x6b175474e89094c44da98b954eedeac495271d0f", ["DAI", 18]],
]);

/**
 * The asset a symbol names, without issuer decorations: `axlUSDC`,
 * `PolygonUSDC.axl`, `solana.USDC.wh`, `USDC.e.matic.axl` and `USDC.n` are all
 * `USDC`. Wrapped ETH goes to its root (`WETH` → `ETH`; WETH stays an alias),
 * and Tether's `USDt` is `USDT`. The network a prefix names is carried by the
 * row's `sourceNetwork`, so dropping it here loses nothing.
 */
export function familyOf(symbol: string): string {
  let text = symbol.trim();
  text = text.replace(/^axl(?=[A-Z])/, "");
  text = text.replace(/^(Polygon|Avalanche|Arbitrum|Optimism|Base|Binance)(?=[A-Z])/, "");
  text = text.replace(/^(solana|avalanche|polygon|arbitrum|optimism|base|ethereum|binance|bsc)\.(?=[A-Za-z])/, "");
  const parts = text.split(".");
  while (parts.length > 1 && DECORATIONS.has((parts[parts.length - 1] ?? "").toLowerCase())) parts.pop();
  text = parts.join(".");
  if (/^usdt$/i.test(text)) return "USDT";
  if (/^usdc$/i.test(text)) return "USDC";
  if (/^w?eth$/i.test(text)) return "ETH";
  if (/^wbtc$/i.test(text)) return "WBTC";
  return text || symbol;
}

let homeIssuers: Map<string, string> | null = null;

/**
 * The one mainnet chain whose staking coin is `family`. Chains that pay gas in
 * someone else's coin (an `ibc/` or `l2/` native) do not count, and when two
 * registry chains share a native ticker neither is home. Built from the
 * bundled catalog only, so a custom chain can never become a home issuer.
 */
function homeIssuerOf(family: string): string | undefined {
  if (!homeIssuers) {
    const byFamily = new Map<string, CatalogEntry[]>();
    for (const entry of CHAIN_CATALOG) {
      if (entry.network !== "mainnet" || /^(ibc|l2)\//.test(entry.coinMinimalDenom)) continue;
      const key = familyOf(entry.coinDenom);
      byFamily.set(key, [...(byFamily.get(key) ?? []), entry]);
    }
    homeIssuers = new Map();
    for (const [key, entries] of byFamily) {
      const listed = entries.length > 1 ? entries.filter((entry) => entry.inCosmosRegistry) : entries;
      if (listed.length === 1 && listed[0]) homeIssuers.set(key, listed[0].chainId);
    }
  }
  return homeIssuers.get(family);
}

/** A testnet or a chain the user added: never an issuer, never renames anyone. */
function isNeverIssuer(chainId: string): boolean {
  if (getCustomCatalogEntries().some((entry) => entry.chainId === chainId)) return true;
  return findCatalogEntry(chainId)?.network === "testnet";
}

function issuerTag(chainId: string): string {
  return ISSUER_TAG.get(chainId) ?? (prefixOfChain(chainId) || chainId);
}

/**
 * The ticker for an asset, from its origin and never its location:
 * 1. an Osmosis alloy is `all` + family (`allUSDC`), so a bare USDC never shows;
 * 2. a bridged asset takes the bridge tag, plus the source network for a
 *    multi-issuer family when it is not Ethereum (`USDC.axl.polygon`);
 * 3. a multi-issuer family minted on a chain takes the issuer tag (`USDC.n`);
 * 4. any other family is bare on its home issuer (`ATOM` on the Hub) and
 *    tagged elsewhere (`ATOM.thor`);
 * 5. a testnet or custom origin is never tagged.
 * Same-chain duplicates are separated afterwards by the collision guard.
 */
export function tickerFor(input: TickerInput): string {
  const family = input.family;
  if (input.alloyed) return `all${family}`;
  if (input.originChainId && isNeverIssuer(input.originChainId)) return family;
  if (input.bridge) {
    const network = input.sourceNetwork && MULTI_ISSUER.has(family) ? `.${input.sourceNetwork}` : "";
    return `${family}.${input.bridge}${network}`;
  }
  if (!input.originChainId) return family;
  if (MULTI_ISSUER.has(family)) return `${family}.${issuerTag(input.originChainId)}`;
  const home = homeIssuerOf(family);
  return !home || home === input.originChainId ? family : `${family}.${issuerTag(input.originChainId)}`;
}

/**
 * Family, bridge and network of a catalog currency issued on its own chain.
 * `denom` is the held spelling; the catalog's may differ in case for erc20.
 *
 * A hash-verified table row about the same asset wins over the symbol, so the
 * issuer and every chain holding a voucher read the same ticker (rule 7):
 * Wormhole Gateway's own USDC is `USDC.wh` there exactly as on Osmosis, not
 * `USDC.wormhole` from its bech32 prefix.
 */
function catalogTraits(
  entry: CatalogEntry,
  currency: CatalogCurrency,
  denom: string = currency.coinMinimalDenom,
): { family: string; bridge: TokenBridge | null; sourceNetwork: SourceNetwork | null; alloyed: boolean } {
  const row = tableRow(entry.chainId, denom);
  if (row && row.originChainId === entry.chainId && !row.path) {
    return { family: row.family, bridge: row.bridge, sourceNetwork: row.sourceNetwork, alloyed: row.alloyed };
  }
  const issued = issuerRowOf(entry.chainId, denom) ?? issuerRowOf(entry.chainId, denom, true);
  if (issued) {
    return { family: issued.family, bridge: issued.bridge, sourceNetwork: issued.sourceNetwork, alloyed: false };
  }
  const symbol = currency.coinDenom;
  const prefix = /^(Polygon|Avalanche|Arbitrum|Optimism|Base|Binance)(?=[A-Z])/.exec(symbol)?.[1];
  let sourceNetwork: SourceNetwork | null = prefix ? (NETWORK_PREFIX.get(prefix) ?? null) : null;
  let bridge: TokenBridge | null = null;
  if (/^peggy0x/i.test(denom)) bridge = "peggy";
  else if (/^gravity0x/i.test(denom)) bridge = "grv";
  else if (entry.chainId === "thorchain-1" && THOR_POOL.test(denom)) {
    bridge = "thor";
    sourceNetwork = THOR_NETWORK.get(denom.split("-")[0] ?? "") ?? null;
  } else if (entry.chainId === "axelar-dojo-1" && denom !== entry.coinMinimalDenom) bridge = "axl";
  // Every token-factory denom on the Wormhole Gateway is the token bridge's.
  else if (entry.chainId === "wormchain" && denom.startsWith("factory/")) bridge = "wh";
  else {
    const tags = symbol.split(".").slice(1).map((tag) => tag.toLowerCase());
    bridge = [...tags].reverse().find(isBridge) ?? null;
  }
  return { family: familyOf(symbol), bridge, sourceNetwork, alloyed: false };
}

/**
 * The ticker of a catalog currency on its own chain, under {@link tickerFor}.
 * For chain-catalog.ts (`chainTicker`, `feeTicker`); a held denom goes through
 * {@link identityOf} instead.
 */
export function catalogTicker(entry: CatalogEntry, currency: CatalogCurrency): string {
  if (isNeverIssuer(entry.chainId)) return currency.coinDenom;
  const denom = currency.coinMinimalDenom;
  if (/^(ibc|l2)\//.test(denom)) {
    // Gas paid in someone else's coin: a voucher (moo-1's INIT) or what the
    // OPinit bridge minted on an Initia L2 (`l2/…`). The listing chain did
    // not issue it, so the ticker never carries that chain's tag.
    const proven = isIbcDenom(denom) ? identityOf(entry.chainId, denom) : undefined;
    if (proven && proven.provenance !== "unknown") return proven.ticker;
    const family = familyOf(currency.coinDenom);
    const home = homeIssuerOf(family);
    return home ? tickerFor({ family, originChainId: home }) : currency.coinDenom;
  }
  const traits = catalogTraits(entry, currency);
  return tickerFor({ ...traits, originChainId: entry.chainId });
}

/**
 * The issuer a ticker describes. An `l2/…` denom is what Initia's OPinit
 * bridge minted for a deposit from L1: the L2 holds and mints it but did not
 * issue the asset, so INIT on an L2 reads `INIT`, not `INIT.init` after the
 * L2's prefix.
 */
function tickerOriginOf(draft: Draft): string | null {
  if (draft.originDenom?.startsWith("l2/")) return homeIssuerOf(draft.family) ?? null;
  return draft.originChainId;
}

/**
 * The table row that proves `denom` is issued on `chainId`: a voucher whose
 * first hop lands on its issuer, so unwinding it delivers exactly this denom
 * there. It names the issuer's own denom the way the voucher is named, even
 * when the catalog does not list it (Axelar's `polygon-uusdt`, Picasso's ETH,
 * the Hub's Eureka tokens). `folded` matches erc20 and peggy spellings without
 * case, for traits only: a folded match is never a denom.
 */
function issuerRowOf(chainId: string, denom: string, folded = false): TokenTableRow | undefined {
  const index = tableIndex();
  if (!folded) return index.issuerRows.get(`${chainId}:${denomKey(denom)}`);
  const exact = index.issuerSpellings.get(`${chainId}:${foldDenom(denom)}`);
  return exact === undefined ? undefined : index.issuerRows.get(`${chainId}:${denomKey(exact)}`);
}

/* -------------------------------------------------------------------------- *
 * IBC arithmetic
 * -------------------------------------------------------------------------- */

/**
 * `ibc/` + uppercase sha256 of `path/baseDenom`, synchronously. The denom a
 * voucher has on the chain whose trace `path` is (ibc-go's DenomTrace.Hash).
 */
export function ibcDenomFor(path: string, baseDenom: string): string {
  const trimmed = path.replace(/^\/+|\/+$/g, "");
  const full = trimmed ? `${trimmed}/${baseDenom}` : baseDenom;
  return `ibc/${bytesToHex(sha256(utf8ToBytes(full))).toUpperCase()}`;
}

const isIbcDenom = (denom: string): boolean => denom.startsWith("ibc/");

/** Table and cache key: `ibc/` hashes uppercase, every other denom exact. */
function denomKey(denom: string): string {
  return isIbcDenom(denom) ? `ibc/${denom.slice(4).toUpperCase()}` : denom;
}

/** True when `path/baseDenom` hashes to `denom`. A trace that does not is rejected. */
function traceMatches(denom: string, path: string, baseDenom: string): boolean {
  if (!isIbcDenom(denom) || !baseDenom) return false;
  return ibcDenomFor(path, baseDenom) === denomKey(denom);
}

function firstChannelOf(path: string): string | null {
  return /^[^/]+\/(channel-\d+)(?:\/|$)/.exec(path)?.[1] ?? null;
}

/* -------------------------------------------------------------------------- *
 * The generated table
 * -------------------------------------------------------------------------- */

interface TableIndex {
  readonly rows: readonly TokenTableRow[];
  readonly byKey: ReadonlyMap<string, TokenTableRow>;
  readonly byChain: ReadonlyMap<string, readonly TokenTableRow[]>;
  /** `${originChainId}:${originDenom}` → the canonical Osmosis voucher. */
  readonly osmosisByOrigin: ReadonlyMap<string, TokenTableRow>;
  /**
   * `${originChainId}:${originDenom}` → the best voucher row whose first hop
   * lands on its issuer: the proof that the issuer holds that exact denom.
   */
  readonly issuerRows: ReadonlyMap<string, TokenTableRow>;
  /** Issuer chain → the denoms `issuerRows` proves there. */
  readonly issuerDenoms: ReadonlyMap<string, readonly string[]>;
  /** `${originChainId}:${erc20 or peggy denom, lowercased}` → its one proven spelling. */
  readonly issuerSpellings: ReadonlyMap<string, string>;
  /** `${chainId}:${channelId}` → the chain at the other end, from first hops. */
  readonly channels: ReadonlyMap<string, string>;
  readonly chains: ReadonlyMap<string, readonly [string, string]>;
  /** Chain id → (denom, erc20 and peggy lowercased) → logo URL. */
  readonly catalogLogos: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

let table: TableIndex | null = null;

function expandLogo(value: string | undefined): string | null {
  if (!value) return null;
  const prefix = /^\d/.test(value) ? TOKEN_LOGO_PREFIXES[Number(value[0])] : undefined;
  return prefix ? `${prefix}${value.slice(1)}` : value;
}

/** `122/52` → `transfer/channel-122/transfer/channel-52`; a full path stays as is. */
function expandPath(value: string): string {
  if (!/^\d+(\/\d+)*$/.test(value)) return value;
  return value
    .split("/")
    .map((channel) => `transfer/channel-${channel}`)
    .join("/");
}

function decodeRow(tuple: TokenRowTuple): TokenTableRow {
  const chainAt = (index: number) => TOKEN_CHAINS[index]?.[0] ?? "";
  const heldOnChainId = chainAt(tuple[0]);
  const denom = tuple[1];
  const originChainId = chainAt(tuple[2]);
  const originDenom = tuple[3] || denom;
  const path = expandPath(tuple[4]);
  const channelId = firstChannelOf(path);
  const flags = tuple[11];
  const alloyed = (flags & 1) !== 0;
  const aliases = tuple[16] ? tuple[16].split("|") : [];
  return {
    heldOnChainId,
    denom,
    originChainId,
    originDenom,
    path,
    baseDenom: tuple[5] || originDenom,
    channelId,
    // -1 means "the origin" only behind a channel: a light-client hop (the
    // Hub's Eureka `transfer/08-wasm-1369`) leads off Cosmos, to no chain id.
    counterpartyChainId: tuple[6] >= 0 ? chainAt(tuple[6]) : channelId ? originChainId : null,
    counterpartyChannelId: tuple[7] >= 0 ? `channel-${tuple[7]}` : null,
    family: familyOf(tuple[8]),
    bridge: isBridge(tuple[9]) ? tuple[9] : null,
    sourceNetwork: isNetwork(tuple[10]) ? tuple[10] : null,
    alloyed,
    verified: (flags & 2) !== 0,
    stable: (flags & 4) !== 0,
    decimals: tuple[12],
    logoUrl: tuple[13] >= 0 ? expandLogo(TOKEN_LOGOS[tuple[13]]) : null,
    coinGeckoId: tuple[14] || null,
    variantGroup: tuple[15] >= 0 ? (TOKEN_GROUPS[tuple[15]] ?? null) : alloyed ? denom : null,
    aliases,
  };
}

/** Lower is better when several Osmosis vouchers carry one origin asset. */
function osmosisRank(row: TokenTableRow): number {
  const hops = row.path.split("/").length / 2;
  return (row.verified ? 0 : 4) + (row.stable ? 0 : 2) + (hops > 1 ? 1 : 0);
}

function tableIndex(): TableIndex {
  if (table) return table;
  const rows = TOKEN_ROWS.map(decodeRow);
  const byKey = new Map<string, TokenTableRow>();
  const byChain = new Map<string, TokenTableRow[]>();
  const osmosisByOrigin = new Map<string, TokenTableRow>();
  const issuerRows = new Map<string, TokenTableRow>();
  const channels = new Map<string, string>();
  for (const row of rows) {
    byKey.set(`${row.heldOnChainId}:${denomKey(row.denom)}`, row);
    const list = byChain.get(row.heldOnChainId);
    if (list) list.push(row);
    else byChain.set(row.heldOnChainId, [row]);
    if (row.channelId && row.counterpartyChainId) {
      const key = `${row.heldOnChainId}:${row.channelId}`;
      if (!channels.has(key)) channels.set(key, row.counterpartyChainId);
    }
    if (row.heldOnChainId === OSMOSIS && row.path) {
      const key = `${row.originChainId}:${row.originDenom}`;
      const best = osmosisByOrigin.get(key);
      if (!best || osmosisRank(row) < osmosisRank(best)) osmosisByOrigin.set(key, row);
    }
    if (row.channelId && row.counterpartyChainId === row.originChainId && row.originChainId !== row.heldOnChainId) {
      // Osmosis rows first: its listing carries the verified flags and logos.
      const key = `${row.originChainId}:${denomKey(row.originDenom)}`;
      const best = issuerRows.get(key);
      const rank = (candidate: TokenTableRow) => (candidate.heldOnChainId === OSMOSIS ? 0 : 8) + osmosisRank(candidate);
      if (!best || rank(row) < rank(best)) issuerRows.set(key, row);
    }
  }
  const issuerDenoms = new Map<string, string[]>();
  const issuerSpellings = new Map<string, string>();
  for (const row of issuerRows.values()) {
    issuerDenoms.set(row.originChainId, [...(issuerDenoms.get(row.originChainId) ?? []), row.originDenom]);
    const folded = foldDenom(row.originDenom);
    if (folded !== row.originDenom) issuerSpellings.set(`${row.originChainId}:${folded}`, row.originDenom);
  }
  const chains = new Map<string, readonly [string, string]>(
    TOKEN_CHAINS.map(([id, name, prefix]) => [id, [name, prefix] as const]),
  );
  const catalogLogos = new Map<string, Map<string, string>>();
  for (const [chainId, dir, entries] of CATALOG_LOGOS) {
    const logos = new Map<string, string>();
    for (const entry of entries) {
      const denom = entry[0];
      const url =
        entry.length === 2
          ? expandLogo(TOKEN_LOGOS[entry[1]])
          : `${TOKEN_LOGO_PREFIXES[1]}${dir}/${denom.replace(/:/g, "/")}.png`;
      if (url) logos.set(foldDenom(denom), url);
    }
    catalogLogos.set(chainId, logos);
  }
  table = {
    rows,
    byKey,
    byChain,
    osmosisByOrigin,
    issuerRows,
    issuerDenoms,
    issuerSpellings,
    channels,
    chains,
    catalogLogos,
  };
  return table;
}

function tableRow(chainId: string, denom: string): TokenTableRow | undefined {
  return tableIndex().byKey.get(`${chainId}:${denomKey(denom)}`);
}

const foldDenom = (denom: string): string => (/^(erc20:|peggy)/i.test(denom) ? denom.toLowerCase() : denom);

function catalogLogo(chainId: string, denom: string): string | null {
  return tableIndex().catalogLogos.get(chainId)?.get(foldDenom(denom)) ?? null;
}

/**
 * Rows of the generated table, all of them or those held on one chain. The
 * swap lists read Osmosis's verified rows from here, and their delivery-to-
 * issuer rows use each row's `originDenom`, which is hash-verified exact case.
 */
export function tokenTableRows(heldOnChainId?: string): readonly TokenTableRow[] {
  const index = tableIndex();
  return heldOnChainId ? (index.byChain.get(heldOnChainId) ?? []) : index.rows;
}

/**
 * The chain at the other end of `channelId` on `chainId`, from the table's
 * first hops and the channel walks this wallet has proven; `null` when unknown.
 */
export function channelCounterpartyOf(chainId: string, channelId: string): string | null {
  const known = tableIndex().channels.get(`${chainId}:${channelId}`);
  if (known) return known;
  for (const [key, fact] of facts) {
    if (!key.startsWith(`${chainId}:`) || firstChannelOf(fact.p) !== channelId) continue;
    const next = fact.h?.[0];
    if (next) return next;
  }
  return null;
}

/**
 * The asset's denom on osmosis-1: the origin denom when Osmosis is the issuer,
 * else the canonical voucher the table lists (verified and stable first). Exact
 * match only: the catalog's lowercase erc20 spelling finds nothing, because
 * its voucher (`ibc/D3B2…`) is not the one Osmosis trades (`ibc/794C…`).
 */
export function osmosisDenomOf(originChainId: string, originDenom: string): string | null {
  if (!originChainId || !originDenom) return null;
  if (originChainId === OSMOSIS) return originDenom;
  return tableIndex().osmosisByOrigin.get(`${originChainId}:${originDenom}`)?.denom ?? null;
}

/* -------------------------------------------------------------------------- *
 * Chains
 * -------------------------------------------------------------------------- */

function chainNameOf(chainId: string): string {
  return findCatalogEntry(chainId)?.chainName ?? tableIndex().chains.get(chainId)?.[0] ?? chainId;
}

function prefixOfChain(chainId: string): string {
  return findCatalogEntry(chainId)?.bech32Prefix ?? tableIndex().chains.get(chainId)?.[1] ?? "";
}

/* -------------------------------------------------------------------------- *
 * The facts cache: proven traces the table does not list
 * -------------------------------------------------------------------------- */

/** One proven trace. Facts, never labels, so a rule change needs no wipe. */
interface TraceFact {
  /** Origin chain id. */
  readonly o: string;
  /** Base denom on the origin. */
  readonly b: string;
  /** Trace path on the holding chain. */
  readonly p: string;
  /** Chain after each hop. */
  readonly h?: readonly (string | null)[];
  /** When it was learned, for trimming. */
  readonly at: number;
}

const FACTS_VERSION = 1;
const FACTS_MAX = 500;
/** A voucher that could not be traced is not asked about again for this long. */
const MISS_TTL_MS = 30 * 60_000;
/**
 * Point lookups per call. The resolver stops there and returns the rest
 * unanswered, so only this many are asked, and only those can be a miss; the
 * others wait for the next balance read.
 */
const MAX_LOOKUPS = 32;

const facts = new Map<string, TraceFact>();
const misses = new Map<string, number>();
let generation = 0;
let listening = false;

const factKey = (chainId: string, denom: string): string => `${chainId}:${denomKey(denom)}`;

/**
 * Read a stored record, keeping only facts whose trace still hashes to their
 * denom: storage is shared by every context and is not trusted on its own.
 */
function parseFacts(raw: unknown): Map<string, TraceFact> {
  const out = new Map<string, TraceFact>();
  const record = raw as { version?: unknown; facts?: unknown } | null | undefined;
  if (!record || record.version !== FACTS_VERSION || !record.facts || typeof record.facts !== "object") return out;
  for (const [key, value] of Object.entries(record.facts as Record<string, unknown>)) {
    const fact = value as Partial<TraceFact> | null;
    const split = key.indexOf(":ibc/");
    if (!fact || split < 0 || typeof fact.o !== "string" || typeof fact.b !== "string" || typeof fact.p !== "string") {
      continue;
    }
    // An origin is a chain id; an empty one is a damaged record, not a fact.
    if (!fact.o || !fact.b) continue;
    if (!traceMatches(key.slice(split + 1), fact.p, fact.b)) continue;
    out.set(key, {
      o: fact.o,
      b: fact.b,
      p: fact.p,
      ...(Array.isArray(fact.h) ? { h: fact.h.map((hop) => (typeof hop === "string" ? hop : null)) } : {}),
      at: typeof fact.at === "number" ? fact.at : 0,
    });
  }
  return out;
}

function adoptFacts(incoming: ReadonlyMap<string, TraceFact>): void {
  let changed = false;
  for (const [key, fact] of incoming) {
    const current = facts.get(key);
    if (current && current.at >= fact.at) continue;
    facts.set(key, fact);
    changed = true;
  }
  if (changed) generation += 1;
}

function listenForFacts(): void {
  if (listening) return;
  try {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      const change = changes[STORAGE_KEYS.tokenIdentity];
      if (change) adoptFacts(parseFacts(change.newValue));
    });
    listening = true;
  } catch {
    // No storage events in this context (tests, a bare worker): boot reads still work.
  }
}

/**
 * Load the facts cache and follow writes from other contexts. Called from
 * `hydrateCustomChains`, so the background and the popup both have it at
 * boot. Never throws: without storage, the table and the catalog still answer.
 */
export async function hydrateTokenIdentities(): Promise<void> {
  listenForFacts();
  try {
    const stored = await browser.storage.local.get(STORAGE_KEYS.tokenIdentity);
    adoptFacts(parseFacts(stored[STORAGE_KEYS.tokenIdentity]));
  } catch {
    // Storage unavailable here; identities fall back to the table and catalog.
  }
}

async function persistFacts(): Promise<void> {
  try {
    const stored = await browser.storage.local.get(STORAGE_KEYS.tokenIdentity);
    const merged = parseFacts(stored[STORAGE_KEYS.tokenIdentity]);
    for (const [key, fact] of facts) {
      const current = merged.get(key);
      if (!current || current.at < fact.at) merged.set(key, fact);
    }
    const kept = [...merged.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, FACTS_MAX);
    await browser.storage.local.set({
      [STORAGE_KEYS.tokenIdentity]: { version: FACTS_VERSION, facts: Object.fromEntries(kept) },
    });
  } catch {
    // The facts still answer in this context until it closes.
  }
}

/**
 * Identify a chain's held denoms, once per balance read. Denoms the table or
 * the catalog already name cost nothing; each remaining `ibc/` voucher gets one
 * point lookup (never a full trace sweep) whose trace must hash to the denom
 * and whose channels are walked to the origin chain, at most
 * {@link MAX_LOOKUPS} per call. A voucher that was asked about and could not
 * be traced is not looked up again for {@link MISS_TTL_MS}. Rejects only when
 * `signal` aborts.
 */
export async function identifyHeld(
  chainId: string,
  denoms: readonly string[],
  options: IdentifyHeldOptions = {},
): Promise<ReadonlyMap<string, TokenIdentity>> {
  const now = Date.now();
  const wanted = [
    ...new Set(
      denoms.filter((denom) => {
        if (!isIbcDenom(denom) || identityOf(chainId, denom).provenance !== "unknown") return false;
        const missed = misses.get(factKey(chainId, denom));
        return missed === undefined || now - missed > MISS_TTL_MS;
      }),
    ),
  ].slice(0, MAX_LOOKUPS);
  if (wanted.length > 0) {
    let found: Awaited<ReturnType<DenomTraceResolver["identifyDenoms"]>> = new Map();
    try {
      const resolver = options.resolver ?? denomResolver();
      found = await resolver.identifyDenoms(chainId, wanted, {
        ...(options.signal ? { signal: options.signal } : {}),
        bulkThreshold: Number.MAX_SAFE_INTEGER,
        maxLookups: MAX_LOOKUPS,
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      // Live reads switched off says nothing about the vouchers: ask again
      // once they are back on instead of remembering a miss.
      if (isInterchainError(error) && error.code === "reads-disabled") {
        return new Map(denoms.map((denom) => [denom, identityOf(chainId, denom)]));
      }
    }
    // A cancelled read proves nothing missing, even if the resolver returned.
    if (options.signal?.aborted) {
      throw new InterchainError("aborted", `${chainId}: token identification cancelled`, { chainId });
    }
    let learned = 0;
    for (const denom of wanted) {
      const hit = found.get(denom);
      if (!hit?.originChainId || !traceMatches(denom, hit.path, hit.baseDenom)) {
        misses.set(factKey(chainId, denom), now);
        continue;
      }
      facts.set(factKey(chainId, denom), {
        o: hit.originChainId,
        b: hit.baseDenom,
        p: hit.path,
        ...(hit.hopChainIds ? { h: [...hit.hopChainIds] } : {}),
        at: now,
      });
      learned += 1;
    }
    if (learned > 0) {
      generation += 1;
      await persistFacts();
    }
  }
  return new Map(denoms.map((denom) => [denom, identityOf(chainId, denom)]));
}

/* -------------------------------------------------------------------------- *
 * Resolution
 * -------------------------------------------------------------------------- */

/** An identity before the ticker, the name and the guard are applied. */
interface Draft {
  readonly heldOnChainId: string;
  readonly denom: string;
  readonly kind: TokenKind;
  readonly originChainId: string | null;
  readonly originDenom: string | null;
  readonly path: string;
  readonly hopChainIds: readonly (string | null)[];
  /** The registry symbol, or a readable stand-in when `named` is false. */
  readonly symbol: string;
  readonly family: string;
  readonly bridge: TokenBridge | null;
  readonly sourceNetwork: SourceNetwork | null;
  readonly alloyed: boolean;
  readonly decimals: number | null;
  readonly logoUrl: string | null;
  readonly coinGeckoId: string | null;
  readonly variantGroup: string | null;
  readonly aliases: readonly string[];
  readonly provenance: TokenProvenance;
  /** The symbol comes from the catalog, the table or a known contract. */
  readonly named: boolean;
  /** Rank in the collision guard: lower keeps the bare ticker. */
  readonly rank: number;
  /** For a channel walk: every hop crossed a registry-canonical channel. */
  readonly walkCanonical?: boolean;
}

function kindOf(chainId: string, denom: string): TokenKind {
  if (isIbcDenom(denom)) return "ibc";
  if (denom.startsWith("factory/")) return "factory";
  if (/^erc20[:/]/i.test(denom)) return "erc20";
  if (/^peggy0x/i.test(denom)) return "peggy";
  if (/^cw20:/i.test(denom)) return "cw20";
  const entry = findCatalogEntry(chainId);
  if (entry && (denom === entry.coinMinimalDenom || denom === entry.feeMinimalDenom)) return "native";
  return "other";
}

function unknownDraft(chainId: string, denom: string): Draft {
  return {
    heldOnChainId: chainId,
    denom,
    kind: kindOf(chainId, denom),
    originChainId: null,
    originDenom: null,
    path: "",
    hopChainIds: [],
    symbol: "",
    family: "",
    bridge: null,
    sourceNetwork: null,
    alloyed: false,
    decimals: null,
    logoUrl: null,
    coinGeckoId: null,
    variantGroup: null,
    aliases: [],
    provenance: "unknown",
    named: false,
    rank: 9,
  };
}

/**
 * Decimals turn a typed amount into the amount that gets signed, so when the
 * catalog and the table disagree about one asset (Osmosis lists allSHIB at 12,
 * the catalog at 18) neither is trusted: the amount stays in base units.
 */
function agreedDecimals(first: number | null, second: number | null | undefined): number | null {
  if (first === null || second === null || second === undefined) return first;
  return first === second ? first : null;
}

function hopsOf(row: TokenTableRow): (string | null)[] {
  if (!row.path) return [];
  const count = row.path.split("/").length / 2;
  return [row.counterpartyChainId, ...Array.from({ length: count - 1 }, () => null)];
}

/**
 * The row of the voucher a relay holds, when `row` reached its listed origin
 * through that relay rather than from the issuer. Osmosis lists LBTC as the
 * Hub's (one hop back, which is what delivery needs) while the Hub's own row
 * walks it on to Lombard, its issuer. Adopted only when its trace is exactly
 * the rest of `row`'s, so both rows' hashes prove one journey.
 */
function relayedRowOf(row: TokenTableRow): TokenTableRow | undefined {
  if (!row.path || row.originChainId === row.heldOnChainId) return undefined;
  const inner = tableRow(row.originChainId, row.originDenom);
  if (!inner?.channelId || inner.originChainId === inner.heldOnChainId) return undefined;
  const rest = row.path.split("/").slice(2).join("/");
  return inner.path === rest && inner.baseDenom === row.baseDenom ? inner : undefined;
}

function draftFromRow(row: TokenTableRow): Draft {
  // The identity names the issuer; the row keeps the hop delivery unwinds to.
  const relayed = relayedRowOf(row);
  const originChainId = relayed?.originChainId ?? row.originChainId;
  const originDenom = relayed?.originDenom ?? row.originDenom;
  return {
    heldOnChainId: row.heldOnChainId,
    denom: row.denom,
    kind: kindOf(row.heldOnChainId, row.denom),
    originChainId,
    originDenom,
    path: row.path,
    hopChainIds: relayed ? [row.counterpartyChainId, ...hopsOf(relayed)] : hopsOf(row),
    symbol: row.family,
    family: row.family,
    bridge: row.bridge,
    sourceNetwork: row.sourceNetwork,
    alloyed: row.alloyed,
    decimals: agreedDecimals(
      agreedDecimals(row.decimals, relayed?.decimals),
      findCurrencyOn(originChainId, originDenom)?.currency.coinDecimals,
    ),
    logoUrl: row.logoUrl,
    coinGeckoId: row.coinGeckoId,
    variantGroup: row.variantGroup,
    aliases: row.aliases,
    provenance: row.path ? "table" : "native",
    named: true,
    rank: row.verified && row.stable ? 1 : row.verified ? 2 : 3,
  };
}

function draftFromCatalog(
  chainId: string,
  denom: string,
  entry: CatalogEntry,
  currency: CatalogCurrency,
): Draft {
  // The same asset as the table knows it: a row held here, else the voucher
  // row that proves this exact denom on its issuer (what Osmosis trades).
  const row = tableRow(chainId, denom) ?? issuerRowOf(chainId, denom);
  const traits = catalogTraits(entry, currency, denom);
  const native = denom === entry.coinMinimalDenom || denom === entry.feeMinimalDenom;
  return {
    heldOnChainId: chainId,
    denom,
    kind: kindOf(chainId, denom),
    originChainId: chainId,
    originDenom: denom,
    path: "",
    hopChainIds: [],
    symbol: currency.coinDenom,
    family: traits.family,
    bridge: traits.bridge,
    sourceNetwork: traits.sourceNetwork,
    alloyed: traits.alloyed,
    decimals: agreedDecimals(currency.coinDecimals, row?.decimals),
    logoUrl: (row?.heldOnChainId === chainId ? row.logoUrl : null) ?? catalogLogo(chainId, denom) ?? row?.logoUrl ?? null,
    coinGeckoId: currency.coinGeckoId ?? row?.coinGeckoId ?? (native ? (entry.coinGeckoId ?? null) : null),
    variantGroup: row?.variantGroup ?? null,
    aliases: row?.aliases ?? [],
    provenance: native ? "native" : "catalog",
    named: true,
    rank: 0,
  };
}

/** The issuer's side of {@link issuerRowOf}: the voucher's trace minus its first hop. */
function issuerTrace(row: TokenTableRow): { path: string; base: string } {
  const path = row.path.split("/").slice(2).join("/");
  // A light-client hop (`transfer/08-wasm-1369/0x…`) stays inside the base on
  // the voucher's row; split it back out so the path reads as one.
  const hop = path ? null : /^([^/]+\/\d{2}-[a-z][a-z0-9]*-\d+)\/(.+)$/.exec(row.baseDenom);
  return hop ? { path: hop[1] ?? "", base: hop[2] ?? "" } : { path, base: row.baseDenom };
}

/**
 * A denom on its issuer that the catalog does not list but a table voucher
 * proves (Axelar's `polygon-uusdt`, Picasso's ETH voucher, the Hub's Eureka
 * ETH). Named exactly as that voucher, so the token reads the same on the
 * issuer and wherever it travels. `undefined` when an `ibc/` denom's derived
 * trace does not hash back to it.
 */
function draftFromIssuerRow(chainId: string, denom: string, row: TokenTableRow): Draft | undefined {
  let path = "";
  if (isIbcDenom(denom)) {
    const trace = issuerTrace(row);
    if (!traceMatches(denom, trace.path, trace.base)) return undefined;
    path = trace.path;
  }
  return {
    heldOnChainId: chainId,
    denom,
    kind: kindOf(chainId, denom),
    originChainId: chainId,
    originDenom: denom,
    path,
    hopChainIds: path ? Array.from({ length: path.split("/").length / 2 }, () => null) : [],
    symbol: row.family,
    family: row.family,
    bridge: row.bridge,
    sourceNetwork: row.sourceNetwork,
    alloyed: row.alloyed,
    decimals: agreedDecimals(row.decimals, findCurrencyOn(chainId, denom)?.currency.coinDecimals),
    logoUrl: row.logoUrl,
    coinGeckoId: row.coinGeckoId,
    variantGroup: row.variantGroup,
    aliases: row.aliases,
    provenance: "table",
    named: true,
    rank: row.verified && row.stable ? 1 : row.verified ? 2 : 3,
  };
}

/**
 * The Ethereum bridges whose module mints `<prefix>0x<contract>` denoms, and
 * the one mainnet chain each runs on. Anywhere else (a testnet's Sepolia
 * contracts, a chain without the module) the same string proves nothing.
 */
const CONTRACT_BRIDGES: ReadonlyMap<string, readonly [string, TokenBridge]> = new Map([
  ["peggy", ["injective-1", "peggy"]],
  ["gravity", ["gravity-bridge-3", "grv"]],
]);

/**
 * A local denom no registry lists. It was minted on the chain that holds it
 * (only `ibc/` denoms travel), so the origin is known; the name is not, unless
 * the denom embeds a known Ethereum contract on the chain whose bridge mints
 * such denoms (`peggy0xA0b8…` on Injective is USDC).
 */
function draftFromLocal(chainId: string, denom: string): Draft {
  const base = unknownDraft(chainId, denom);
  if (!findCatalogEntry(chainId)) return base;
  const bridged = /^(peggy|gravity)(0x[0-9a-fA-F]{40})$/.exec(denom);
  const minter = bridged ? CONTRACT_BRIDGES.get(bridged[1] ?? "") : undefined;
  const known =
    bridged && minter?.[0] === chainId ? ETHEREUM_TOKENS.get((bridged[2] ?? "").toLowerCase()) : undefined;
  if (minter && known) {
    return {
      ...base,
      originChainId: chainId,
      originDenom: denom,
      symbol: known[0],
      family: known[0],
      bridge: minter[1],
      decimals: known[1],
      provenance: "native",
      named: true,
      rank: 0,
    };
  }
  const symbol = denom.startsWith("factory/") ? (denom.split("/").pop() ?? "") : "";
  return { ...base, originChainId: chainId, originDenom: denom, symbol, provenance: "native", rank: 5 };
}

let canonicalHops: Set<string> | null = null;

/** Whether the registry names `channelId` on `chainId` as the canonical channel to `counterparty`. */
function isCanonicalHop(chainId: string, channelId: string, counterparty: string): boolean {
  canonicalHops ??= new Set(IBC_CHANNEL_ROWS.map(([source, channel, dest]) => `${source}|${channel}|${dest}`));
  return canonicalHops.has(`${chainId}|${channelId}|${counterparty}`);
}

/**
 * Whether a walked trace crossed only registry-canonical transfer channels,
 * hop by hop from the holding chain back to the origin. A hop whose far chain
 * the walk could not name fails the check.
 */
function walkedCanonically(holdingChainId: string, fact: TraceFact): boolean {
  const segments = fact.p.split("/");
  if (segments.length === 0 || segments.length % 2 !== 0) return false;
  let chain = holdingChainId;
  for (let hop = 0; hop < segments.length / 2; hop++) {
    const port = segments[hop * 2];
    const channel = segments[hop * 2 + 1];
    const next = fact.h?.[hop];
    if (port !== "transfer" || !channel || !next || !isCanonicalHop(chain, channel, next)) return false;
    chain = next;
  }
  return true;
}

/**
 * A voucher named from a proven channel walk: the asset is its origin's denom.
 * When the origin's base is unnamed (a chain the catalog does not carry), the
 * holding chain's own catalog listing of this exact voucher may name it, the
 * way Osmosis lists Penumbra's UM; the walk still supplies the origin.
 */
function draftFromFact(chainId: string, denom: string, fact: TraceFact): Draft {
  const inner = localDraftOf(fact.o, fact.b);
  const canonical = tableIndex().osmosisByOrigin.get(`${fact.o}:${fact.b}`);
  const listed = inner.named ? undefined : findCurrencyOn(chainId, denom)?.currency;
  const unnamedSymbol = fact.b.startsWith("factory/") ? (fact.b.split("/").pop() ?? "") : "";
  return {
    ...inner,
    heldOnChainId: chainId,
    denom,
    kind: "ibc",
    originChainId: fact.o,
    originDenom: fact.b,
    path: fact.p,
    hopChainIds: fact.h ?? [],
    symbol: inner.named ? inner.symbol : (listed?.coinDenom ?? unnamedSymbol),
    family: inner.named ? inner.family : listed ? familyOf(listed.coinDenom) : inner.family,
    decimals: inner.named ? inner.decimals : (listed?.coinDecimals ?? null),
    named: inner.named || listed !== undefined,
    aliases: [...inner.aliases, ...(canonical?.aliases ?? [])],
    coinGeckoId: inner.coinGeckoId ?? listed?.coinGeckoId ?? canonical?.coinGeckoId ?? null,
    variantGroup: inner.variantGroup ?? canonical?.variantGroup ?? null,
    provenance: "channel-walk",
    // An unnamed walk never outranks a named token in the collision guard.
    rank: inner.named || listed !== undefined ? 4 : 6,
    walkCanonical: walkedCanonically(chainId, fact),
  };
}

/**
 * A denom as its own chain sees it: the catalog, a table row held there, the
 * voucher row that proves it on its issuer, else an unlisted local denom.
 *
 * An erc20 or peggy spelling that differs only in case from the one the table
 * proves is a different bank denom (Injective's lowercase USDC has no supply
 * and hashes to `ibc/D3B2…`, not the `ibc/794C…` Osmosis trades), so it stays
 * unknown instead of borrowing USDC.inj through the catalog's case-folding.
 */
function localDraftOf(chainId: string, denom: string): Draft {
  const exact = tableIndex().issuerSpellings.get(`${chainId}:${foldDenom(denom)}`);
  if (exact !== undefined && exact !== denom) return unknownDraft(chainId, denom);
  const hit = findCurrencyOn(chainId, denom) ?? cw20Listing(chainId, denom);
  if (hit) return draftFromCatalog(chainId, denom, hit.entry, hit.currency);
  const row = tableRow(chainId, denom);
  if (row) return draftFromRow(row);
  const issued = issuerRowOf(chainId, denom);
  const fromIssuer = issued ? draftFromIssuerRow(chainId, denom, issued) : undefined;
  if (fromIssuer) return fromIssuer;
  return draftFromLocal(chainId, denom);
}

/**
 * The catalog row of a `cw20:<contract>` denom (how IBC spells a CW20) when
 * the catalog lists the contract bare, as it does for Terra's ROAR: one token
 * under two spellings, not two tokens to tell apart.
 */
function cw20Listing(
  chainId: string,
  denom: string,
): { entry: CatalogEntry; currency: CatalogCurrency } | undefined {
  return denom.startsWith("cw20:") ? findCurrencyOn(chainId, denom.slice("cw20:".length)) : undefined;
}

/**
 * A packet denom (`transfer/channel-0/uatom`, or Eureka's
 * `transfer/08-wasm-1369/0x…`): the sender's trace, not a bank denom here.
 */
const PACKET_PATH = /^[^/]+\/(?:channel-\d+|\d{2}-[a-z][a-z0-9]*-\d+)\//;

/**
 * The resolution order: for a voucher, a table row held here, the voucher row
 * that proves it on its issuer, then the facts cache; for a local denom, see
 * {@link localDraftOf}. A packet path is not a bank denom and stays unknown.
 */
function draftOf(chainId: string, denom: string): Draft {
  if (!chainId || !denom) return unknownDraft(chainId, denom);
  if (isIbcDenom(denom)) {
    const row = tableRow(chainId, denom);
    if (row) return draftFromRow(row);
    const issued = issuerRowOf(chainId, denom);
    const fromIssuer = issued ? draftFromIssuerRow(chainId, denom, issued) : undefined;
    if (fromIssuer) return fromIssuer;
    const fact = facts.get(factKey(chainId, denom));
    if (fact) return draftFromFact(chainId, denom, fact);
    return unknownDraft(chainId, denom);
  }
  if (PACKET_PATH.test(denom)) return unknownDraft(chainId, denom);
  return localDraftOf(chainId, denom);
}

/* -------------------------------------------------------------------------- *
 * Tickers, the collision guard and the final identity
 * -------------------------------------------------------------------------- */

function unknownTicker(denom: string): string {
  return isIbcDenom(denom) ? `IBC·${denom.slice(4, 8).toUpperCase()}` : shortDenom(denom);
}

/**
 * Four characters that tell two denoms apart: the start of an `ibc/` hash, as
 * the short denom shows it, else the start of the denom's own sha256 (a
 * factory subdenom is free text its creator picked, so it cannot be the tag).
 */
function hashTag(denom: string): string {
  const hex = isIbcDenom(denom) ? denom.slice(4) : bytesToHex(sha256(utf8ToBytes(denom)));
  return hex.slice(0, 4).toUpperCase() || "0000";
}

let knownNames: ReadonlySet<string> | null = null;

/**
 * Every name the registries give an asset, uppercased: catalog symbols, table
 * families and aliases, and the multi-issuer families. Bundled data only, so
 * a chain the user adds cannot change it.
 */
function knownNameSet(): ReadonlySet<string> {
  if (knownNames) return knownNames;
  const names = new Set<string>(["IBC", ...MULTI_ISSUER]);
  const add = (symbol: string) => {
    if (!symbol) return;
    names.add(symbol.toUpperCase());
    names.add(familyOf(symbol).toUpperCase());
  };
  for (const row of tableIndex().rows) {
    add(row.family);
    row.aliases.forEach(add);
  }
  for (const entry of CHAIN_CATALOG) {
    add(entry.coinDenom);
    for (const currency of currenciesOf(entry)) add(currency.coinDenom);
  }
  knownNames = names;
  return names;
}

/**
 * The ticker of a token no registry names, from its own free text (a factory
 * subdenom). Anyone can mint `factory/osmo1…/USDC.n` and airdrop it, so when
 * that text claims a name the registries give a real asset, it carries a hash
 * of its denom (`USDC.n·3F2A`) and never reads like the real one. `·` cannot
 * occur in a denom, so the mark cannot be forged.
 */
function unnamedTicker(draft: Draft): string {
  const symbol = draft.symbol;
  if (!symbol) return unknownTicker(draft.denom);
  const known = knownNameSet();
  const words = [symbol, familyOf(symbol), symbol.split(".")[0] ?? "", symbol.replace(/^all(?=[A-Z])/, "")];
  const claimsKnownName = words.some((word) => word.length > 0 && known.has(word.toUpperCase()));
  return claimsKnownName ? `${symbol}·${hashTag(draft.denom)}` : symbol;
}

/**
 * A coin a testnet or a chain the user added issued itself: shown under the
 * symbol it was listed with. A mainnet asset held there is still that asset
 * and keeps its ticker (rule 7); only `proven` and `testnet` say where it is.
 */
function ownSymbolOnly(draft: Draft): boolean {
  return draft.originChainId === null || isNeverIssuer(draft.originChainId);
}

function baseTicker(draft: Draft): string {
  if (draft.provenance === "unknown") return unknownTicker(draft.denom);
  if (!draft.named) return unnamedTicker(draft);
  if (ownSymbolOnly(draft)) return draft.symbol;
  return tickerFor({
    family: draft.family,
    originChainId: tickerOriginOf(draft),
    bridge: draft.bridge,
    sourceNetwork: draft.sourceNetwork,
    alloyed: draft.alloyed,
  });
}

let guards = new Map<string, Map<string, string>>();

/**
 * Tickers on one holding chain after the collision guard. Everything the
 * wallet can name there takes part: the table rows, the denoms the table
 * proves on this issuer, the chain's catalog currencies and the proven facts.
 * When several share a ticker, the best ranked keeps it (the chain's own coin,
 * then verified and stable rows); the others take their issuer tag when that
 * separates them, else a 4-character hash of their denom (`ATOM·1A2B` for a
 * second route of the same ATOM). An unnamed token only ever gets the hash:
 * an issuer tag would dress it as a real variant (`USDC.n.neutron`).
 */
function guardFor(chainId: string): Map<string, string> {
  const cached = guards.get(chainId);
  if (cached) return cached;
  const drafts = new Map<string, Draft>();
  for (const row of tableIndex().byChain.get(chainId) ?? []) drafts.set(denomKey(row.denom), draftOf(chainId, row.denom));
  const entry = findCatalogEntry(chainId);
  if (entry) {
    for (const currency of currenciesOf(entry)) {
      if (isIbcDenom(currency.coinMinimalDenom)) continue;
      const key = denomKey(currency.coinMinimalDenom);
      if (!drafts.has(key)) drafts.set(key, draftOf(chainId, currency.coinMinimalDenom));
    }
  }
  for (const denom of tableIndex().issuerDenoms.get(chainId) ?? []) {
    const key = denomKey(denom);
    if (drafts.has(key) || cw20Listing(chainId, denom)) continue;
    drafts.set(key, draftOf(chainId, denom));
  }
  for (const [key, fact] of facts) {
    if (!key.startsWith(`${chainId}:`)) continue;
    const denom = key.slice(chainId.length + 1);
    if (!drafts.has(denom)) drafts.set(denom, draftFromFact(chainId, denom, fact));
  }
  const groups = new Map<string, Draft[]>();
  for (const draft of drafts.values()) {
    if (draft.provenance === "unknown") continue;
    const ticker = baseTicker(draft);
    groups.set(ticker, [...(groups.get(ticker) ?? []), draft]);
  }
  const taken = new Set(groups.keys());
  const out = new Map<string, string>();
  for (const [ticker, members] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (members.length < 2) continue;
    members.sort((a, b) => a.rank - b.rank || (denomKey(a.denom) < denomKey(b.denom) ? -1 : 1));
    const keeper = members[0];
    for (const draft of members.slice(1)) {
      let next = ticker;
      const tag = draft.named && draft.originChainId ? issuerTag(draft.originChainId) : "";
      if (tag && draft.originChainId !== keeper?.originChainId && !ticker.endsWith(`.${tag}`)) {
        const candidate = `${ticker}.${tag}`;
        if (!taken.has(candidate)) next = candidate;
      }
      if (next === ticker) {
        next = `${ticker}·${hashTag(draft.denom)}`;
        for (let extra = 1; taken.has(next); extra += 1) next = `${next}${extra}`;
      }
      taken.add(next);
      out.set(denomKey(draft.denom), next);
    }
  }
  guards.set(chainId, out);
  return out;
}

function legacyAliases(draft: Draft): string[] {
  if (draft.provenance === "unknown" || draft.alloyed) return [];
  const out: string[] = [];
  if (draft.family === "ETH") out.push("WETH");
  if (draft.bridge === "axl") out.push(`axl${draft.family}`, ...(draft.family === "ETH" ? ["axlWETH"] : []));
  if (draft.family === "USDC" && draft.originChainId === "noble-1") out.push("USDCnb", "USDC.noble");
  if (draft.family === "USDC" && draft.bridge === "wh") out.push("USDCet");
  if (draft.family === "USDT" && draft.originChainId === "kava_2222-10") out.push("USDTkv");
  return out;
}

function nameOf(draft: Draft, originName: string | null, heldName: string): string {
  if (draft.provenance === "unknown") return "Unknown token";
  // The origin is known but nothing names the token: never echo its own free
  // text as a name ("Neutron USDC.n" for anyone's factory/…/USDC.n).
  if (!draft.named) return `Unlisted ${originName ?? heldName} token`;
  if (draft.alloyed) return `Alloyed ${draft.family}`;
  if (ownSymbolOnly(draft)) return `${originName ?? heldName} ${draft.symbol}`.trim();
  const network = draft.sourceNetwork ? ` from ${NETWORK_NAME[draft.sourceNetwork]}` : "";
  return `${originName ?? heldName} ${draft.family}${network}`;
}

function finalize(draft: Draft): TokenIdentity {
  const testnet = isNeverIssuer(draft.heldOnChainId);
  const heldName = chainNameOf(draft.heldOnChainId);
  const originName = draft.originChainId ? chainNameOf(draft.originChainId) : null;
  const guarded = draft.provenance === "unknown" ? undefined : guardFor(draft.heldOnChainId).get(denomKey(draft.denom));
  const ticker = guarded ?? baseTicker(draft);
  const custom = getCustomCatalogEntries();
  const userAdded =
    custom.some((entry) => entry.chainId === draft.heldOnChainId) ||
    (draft.originChainId !== null && custom.some((entry) => entry.chainId === draft.originChainId));
  // No channel joins a testnet to a mainnet issuer: such a walk is forged.
  const crossesNetworks = testnet && draft.originChainId !== null && !isNeverIssuer(draft.originChainId);
  const aliasSet = new Set<string>();
  for (const alias of [...draft.aliases, ...legacyAliases(draft)]) {
    // The family is already a keyword; an alias must add a name users saw.
    if (alias && alias !== ticker && alias !== draft.family) aliasSet.add(alias);
  }
  return {
    key: `${draft.heldOnChainId}:${draft.denom}`,
    heldOnChainId: draft.heldOnChainId,
    heldOnChainName: heldName,
    denom: draft.denom,
    kind: draft.kind,
    originChainId: draft.originChainId,
    originChainName: originName,
    originDenom: draft.originDenom,
    path: draft.path,
    hopChainIds: draft.hopChainIds,
    bridge: draft.bridge,
    sourceNetwork: draft.sourceNetwork,
    family: draft.family || ticker,
    ticker,
    name: nameOf(draft, originName, heldName),
    decimals: draft.decimals ?? 0,
    decimalsKnown: draft.decimals !== null,
    logoUrl: draft.logoUrl,
    coinGeckoId: draft.coinGeckoId,
    variantGroup: draft.variantGroup,
    alloyed: draft.alloyed,
    osmosisDenom:
      draft.heldOnChainId === OSMOSIS
        ? draft.denom
        : draft.originChainId && draft.originDenom
          ? osmosisDenomOf(draft.originChainId, draft.originDenom)
          : null,
    aliases: [...aliasSet],
    provenance: draft.provenance,
    // A chain the user typed in is not evidence, so nothing on it is proven.
    proven:
      draft.provenance !== "unknown" &&
      draft.named &&
      !userAdded &&
      !crossesNetworks &&
      (draft.provenance !== "channel-walk" || draft.walkCanonical === true),
    testnet,
  };
}

const memo = new Map<string, TokenIdentity>();
let memoGeneration = -1;
let memoCustom: readonly CatalogEntry[] | null = null;
const MEMO_MAX = 4_000;

/** Drop derived state when the facts or the user's custom chains change. */
function syncMemo(): void {
  const custom = getCustomCatalogEntries();
  if (memoGeneration === generation && memoCustom === custom) return;
  memo.clear();
  guards = new Map();
  memoGeneration = generation;
  memoCustom = custom;
}

/**
 * The identity of `denom` held on `chainId`. Synchronous and never throws: a
 * denom nothing proves comes back with provenance `unknown`, ticker
 * `IBC·498A`, no origin and unknown decimals, never a guessed issuer.
 */
export function identityOf(chainId: string, denom: string): TokenIdentity {
  try {
    syncMemo();
    const key = `${chainId}:${denom}`;
    const cached = memo.get(key);
    if (cached) return cached;
    const identity = finalize(draftOf(chainId, denom));
    if (memo.size >= MEMO_MAX) memo.clear();
    memo.set(key, identity);
    return identity;
  } catch {
    return {
      key: `${chainId}:${denom}`,
      heldOnChainId: chainId,
      heldOnChainName: chainId,
      denom,
      kind: "other",
      originChainId: null,
      originChainName: null,
      originDenom: null,
      path: "",
      hopChainIds: [],
      bridge: null,
      sourceNetwork: null,
      family: unknownTicker(denom),
      ticker: unknownTicker(denom),
      name: "Unknown token",
      decimals: 0,
      decimalsKnown: false,
      logoUrl: null,
      coinGeckoId: null,
      variantGroup: null,
      alloyed: false,
      osmosisDenom: null,
      aliases: [],
      provenance: "unknown",
      proven: false,
      testnet: false,
    };
  }
}

/* -------------------------------------------------------------------------- *
 * Text
 * -------------------------------------------------------------------------- */

/**
 * The words for one identity, so no screen builds token text itself.
 * - `pill`: `on Osmosis` (line 2; line 1 is the ticker).
 * - `row`: `Native on Injective`, `Noble USDC · on Osmosis`,
 *   `Alloyed USDC · Osmosis only` (`Alloyed USDC · on Neutron` for a voucher
 *   of it), or `Unknown origin · on Osmosis · ibc/498A…6BA6E4`.
 * - `sentence`: `USDC.n (Noble USDC) on Osmosis`, `ATOM on Cosmos Hub`.
 * - `a11y`: `USDC from Noble, on Osmosis`, `ATOM, native on Cosmos Hub`.
 */
export function tokenText(identity: TokenIdentity, variant: TokenTextVariant): string {
  const held = identity.heldOnChainName;
  const unknown = identity.provenance === "unknown";
  const home = !unknown && identity.originChainId === identity.heldOnChainId;
  switch (variant) {
    case "pill":
      return `on ${held}`;
    case "row":
      if (unknown) return `Unknown origin · on ${held} · ${shortDenom(identity.denom)}`;
      // An alloy exists only where it was minted; a voucher of one elsewhere
      // reads like any other voucher ("Alloyed USDC · on Neutron").
      if (identity.alloyed && home) return `${identity.name} · ${held} only`;
      return home ? `Native on ${held}` : `${identity.name} · on ${held}`;
    case "sentence":
      if (unknown) return `unknown token ${shortDenom(identity.denom)} on ${held}`;
      return home ? `${identity.ticker} on ${held}` : `${identity.ticker} (${identity.name}) on ${held}`;
    case "a11y":
      if (unknown) return `Unknown token ${shortDenom(identity.denom)}, on ${held}`;
      if (identity.alloyed) return `${identity.name}, on ${held}`;
      return home
        ? `${identity.ticker}, native on ${held}`
        : `${identity.family} from ${identity.originChainName ?? "an unknown chain"}, on ${held}`;
  }
}

/**
 * Everything a search should match: the ticker, the family, every alias, the
 * name, the origin and location chains (names and ids), the denom and the
 * origin denom. `usdc noble` finds USDC.n through its `USDC.noble` alias and
 * its origin name.
 */
export function tokenKeywords(identity: TokenIdentity): string[] {
  const words = [
    identity.ticker,
    identity.family,
    ...identity.aliases,
    identity.name,
    identity.originChainName ?? "",
    identity.originChainId ?? "",
    identity.heldOnChainName,
    identity.heldOnChainId,
    identity.denom,
    identity.originDenom ?? "",
    identity.sourceNetwork ? NETWORK_NAME[identity.sourceNetwork] : "",
  ];
  return [...new Set(words.filter((word) => word.length > 0))];
}

/** The single label for a token kind. */
export function tokenKindLabel(kind: TokenKind): string {
  switch (kind) {
    case "native":
      return "Native";
    case "ibc":
      return "IBC";
    case "factory":
      return "Factory";
    case "erc20":
      return "ERC-20";
    case "peggy":
      return "Peggy";
    case "cw20":
      return "CW20";
    case "other":
      return "Asset";
  }
}
