/**
 * The swap screen's two lists: what the wallet can sell, and what it can buy
 * and where that will be delivered.
 *
 * Every row is one exact bank denom on one chain, named by its identity
 * (lib/token-identity.ts). The ticker says what the token is and never where
 * it is; the row's chain is where the coin is held (sell) or delivered (buy).
 * Before this, every token Osmosis listed was stamped with Osmosis as its
 * network and logo, so `USDC.inj` read "Osmosis · USDC (Injective)" and USDC
 * on Injective itself could not be picked at all.
 *
 * Signing reads `chainId` and `denom` and nothing else here. A delivery row's
 * denom is the token table's hash-verified `originDenom` (exact case), never a
 * catalog currency string: the catalog spells Injective's USDC in lowercase,
 * which hashes to `ibc/D3B2…` instead of the `ibc/794C…` Osmosis trades.
 */

import { SWAP_VENUE_CHAIN_ID } from "../config/interchain";
import {
  allCatalogEntries,
  catalogIconFor,
  findCatalogEntry,
  getCustomCatalogEntries,
  type CatalogEntry,
} from "./chain-catalog";
import { isCanonicalChannel } from "./interchain";
import type { OsmosisAsset } from "./osmosis-assets";
import type { Searchable } from "./picker";
import { identityOf, tokenKeywords, tokenText, type TokenIdentity } from "./token-identity";
import { gateOptions, osmosisDenomFor, type Executable, type XcsRouteTable } from "./xcs-routes";

const VENUE = SWAP_VENUE_CHAIN_ID;

/** An enabled chain, as the account list provides it. */
export interface SwapChain {
  readonly chainId: string;
  readonly entry: CatalogEntry;
  /** The chain's logo as the account list resolved it. */
  readonly iconUrl?: string;
}

/**
 * What the lists read from a chain's balance: the exact denoms and base units
 * held, and the reader's exponent where its own rule proves one.
 */
export interface HeldBalance {
  readonly tokens: readonly {
    readonly denom: string;
    readonly amount: string;
    readonly decimals?: number;
    /** The balance reader's verdict (lib/balances.ts); only `true` counts. */
    readonly decimalsKnown?: boolean;
  }[];
}

/** One row of either list: a denom on a chain, with what it is and whether it can be picked. */
export interface AssetOption {
  /** `${chainId}:${denom}`: the identity key and the picker-memory id. */
  readonly key: string;
  /** Held on (sell) or delivered on (buy). Signed as is. */
  readonly chainId: string;
  readonly chainName: string;
  /** The location chain's logo, for the badge. Never used as the token's logo. */
  readonly chainIconUrl?: string;
  /** The exact bank denom on `chainId`. Signed as is. */
  readonly denom: string;
  /**
   * What the token is and where it is, carrying this row's exponent:
   * `identity.decimals` and `identity.decimalsKnown` always equal
   * {@link decimals} and {@link decimalsKnown}. The amount helpers take an
   * identity (lib/token-amount.ts), and a row whose two exponents differed
   * would show one scale and convert with another, so Max could sign a
   * million times the balance.
   */
  readonly identity: TokenIdentity;
  /** The ticker (`USDC.inj`). Display only. */
  readonly symbol: string;
  /** The picker label: the ticker. */
  readonly label: string;
  /** Display exponent; 0 when {@link decimalsKnown} is false, so amounts read as base units. */
  readonly decimals: number;
  /**
   * False when nothing proves the exponent, or SQS disagrees with it. A typed
   * amount would then be converted with a guess, so only Max is allowed.
   */
  readonly decimalsKnown: boolean;
  /** Base units held; `"0"` for a row the wallet does not hold. */
  readonly amount: string;
  /** The wallet holds a non-zero amount of this denom on this chain. */
  readonly held: boolean;
  /** The token's logo; a chain logo only for that chain's own staking coin. */
  readonly iconUrl?: string;
  /** Show the seal: the identity is proven, not merely on a registry chain. */
  readonly verified: boolean;
  /**
   * The route table's answer for the current From (lib/xcs-routes.ts).
   * Always `unknown` on the sell list and when the table is unreadable.
   */
  readonly executable: Executable;
  /** Why the row cannot be picked, in the words the picker shows; `null` when it can. */
  readonly disabledReason: string | null;
  /** Shown by a search only, with its reason: every row that cannot be picked. */
  readonly searchOnly: boolean;
  /**
   * On a catalog test network. The To list shows only the From's network.
   * Not `identity.testnet`, which is also true on a chain the user added.
   */
  readonly testnet: boolean;
}

/** What the buy list depends on besides the wallet. */
export interface BuyOptionsInput {
  /** The row being sold: picks the network shown and gates every row. */
  readonly from?: AssetOption | null;
  /** `listOsmosisAssets()`. Empty while it loads or when SQS is unreachable. */
  readonly osmosis?: readonly OsmosisAsset[];
  /** `loadXcsRoutes()`. `null` while it loads or when unreadable, which gates no route. */
  readonly routes?: XcsRouteTable | null;
}

interface RowInput {
  readonly chainId: string;
  readonly denom: string;
  readonly amount: string;
  readonly held: boolean;
  readonly chainIconUrl?: string;
  /** The balance reader's proven exponent for a held token, see {@link exponentOf}. */
  readonly reportedDecimals?: number;
}

const POSITIVE_AMOUNT = /^0*[1-9]\d*$/;

/** SQS's exponent for each Osmosis denom it still lists. */
function listedDecimals(osmosis: readonly OsmosisAsset[]): ReadonlyMap<string, number> {
  return new Map(osmosis.map((asset) => [asset.denom, asset.decimals]));
}

function isCustomChain(chainId: string): boolean {
  return getCustomCatalogEntries().some((entry) => entry.chainId === chainId);
}

/**
 * The exponent a typed amount is converted with, or `null` when nothing proves
 * one. The identity's (catalog or hash-verified table) comes first. Only for a
 * token whose identity is unknown may the balance reader's figure stand in,
 * which it reports only from the chain's own bank metadata: the reader's rule,
 * so Swap and Home agree. Either way, SQS's figure for the asset's Osmosis
 * denom is a further witness, because IBC keeps one exponent per asset: when
 * it disagrees, a typed amount could be signed at the wrong scale.
 */
function exponentOf(
  identity: TokenIdentity,
  venueDenom: string | null,
  reported: number | undefined,
  listed: ReadonlyMap<string, number>,
): number | null {
  const own =
    identity.decimalsKnown
      ? identity.decimals
      : identity.provenance === "unknown" && reported !== undefined
        ? reported
        : null;
  if (own === null) return null;
  const sqs = venueDenom ? listed.get(venueDenom) : undefined;
  return sqs === undefined || sqs === own ? own : null;
}

/**
 * The identity with the row's exponent, so every helper that formats or
 * converts an amount from the identity agrees with the row. A new object only
 * when the exponent differs: SQS vetoed the table's, or the balance reader's
 * bank metadata filled an unknown token's.
 */
function withExponent(identity: TokenIdentity, decimals: number | null): TokenIdentity {
  const known = decimals !== null;
  const value = decimals ?? 0;
  if (identity.decimalsKnown === known && identity.decimals === value) return identity;
  return { ...identity, decimals: value, decimalsKnown: known };
}

function toOption(input: RowInput, listed: ReadonlyMap<string, number>): AssetOption {
  const named = identityOf(input.chainId, input.denom);
  const entry = findCatalogEntry(input.chainId);
  const chainIconUrl = input.chainIconUrl ?? (entry ? catalogIconFor(entry) : undefined);
  const venueDenom = osmosisDenomFor({ chainId: input.chainId, denom: input.denom, identity: named });
  const decimals = exponentOf(named, venueDenom, input.reportedDecimals, listed);
  const identity = withExponent(named, decimals);
  const ownCoin = identity.kind === "native" && identity.originChainId === input.chainId;
  const iconUrl = identity.logoUrl ?? (ownCoin ? chainIconUrl : undefined);
  return {
    key: `${input.chainId}:${input.denom}`,
    chainId: input.chainId,
    chainName: identity.heldOnChainName,
    ...(chainIconUrl ? { chainIconUrl } : {}),
    denom: input.denom,
    identity,
    symbol: identity.ticker,
    label: identity.ticker,
    decimals: identity.decimals,
    decimalsKnown: identity.decimalsKnown,
    amount: input.amount,
    held: input.held,
    ...(iconUrl ? { iconUrl } : {}),
    verified: identity.proven,
    executable: "unknown",
    disabledReason: null,
    searchOnly: false,
    testnet: entry?.network === "testnet",
  };
}

/**
 * Everything the wallet can sell: one row per non-zero balance, per chain
 * and exact bank denom, in the order of `chains` and then of each balance.
 * The sell list holds held balances only, so the source is always the chain
 * the coin is on. Names come from identity, never from the balance reader's
 * labels.
 *
 * @param osmosis - When given, SQS's decimals are checked against the
 *   identity's, so a disagreement makes the amount field Max-only.
 */
export function sellOptions(
  chains: readonly SwapChain[],
  balances: Readonly<Record<string, HeldBalance | undefined>>,
  osmosis: readonly OsmosisAsset[] = [],
): AssetOption[] {
  const listed = listedDecimals(osmosis);
  const out: AssetOption[] = [];
  const seen = new Set<string>();
  for (const chain of chains) {
    for (const token of balances[chain.chainId]?.tokens ?? []) {
      if (!token.denom || !POSITIVE_AMOUNT.test(token.amount)) continue;
      const key = `${chain.chainId}:${token.denom}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const chainIconUrl = chain.iconUrl ?? catalogIconFor(chain.entry);
      const reported = token.decimalsKnown === true ? token.decimals : undefined;
      const sane = typeof reported === "number" && Number.isInteger(reported) && reported >= 0 && reported <= 30;
      out.push(
        toOption(
          {
            chainId: chain.chainId,
            denom: token.denom,
            amount: token.amount,
            held: true,
            ...(chainIconUrl ? { chainIconUrl } : {}),
            ...(sane ? { reportedDecimals: reported } : {}),
          },
          listed,
        ),
      );
    }
  }
  return out;
}

/**
 * Where an Osmosis voucher is delivered when it goes home: its issuer, as the
 * table's exact `originDenom`, over the registry's canonical channel. Only for
 * a voucher whose first hop lands on its listed origin (so unwinding over that
 * channel delivers exactly `originDenom`), on a bundled mainnet, and only when
 * the issuer's identity names this voucher as its Osmosis denom: the planner
 * compares the two and blocks a swap that would buy another variant. Never for
 * a CW20 origin: `cw20:<contract>` is not a bank denom, so the delivered coin
 * would be a contract balance the wallet cannot read or send.
 */
function deliveryOf(asset: OsmosisAsset): RowInput | null {
  const row = asset.row;
  if (!row.path || !row.channelId || row.counterpartyChainId !== row.originChainId) return null;
  if (row.originChainId === VENUE || /^cw20:/i.test(row.originDenom)) return null;
  const entry = findCatalogEntry(row.originChainId);
  if (!entry || entry.network !== "mainnet" || isCustomChain(row.originChainId)) return null;
  if (!isCanonicalChannel(VENUE, row.originChainId, row.channelId)) return null;
  const identity = identityOf(row.originChainId, row.originDenom);
  if (identity.provenance === "unknown" || identity.osmosisDenom !== asset.denom) return null;
  return { chainId: row.originChainId, denom: row.originDenom, amount: "0", held: false };
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Alphabetical by ticker; for one ticker, the issuer's own row before vouchers of it. */
function byTicker(a: AssetOption, b: AssetOption): number {
  const ticker = compareText(a.identity.ticker.toLowerCase(), b.identity.ticker.toLowerCase());
  if (ticker !== 0) return ticker;
  const home = (option: AssetOption) => (option.identity.originChainId === option.chainId ? 0 : 1);
  return (
    home(a) - home(b) ||
    compareText(a.chainName.toLowerCase(), b.chainName.toLowerCase()) ||
    compareText(a.key, b.key)
  );
}

/**
 * Held rows first (in balance order), then rows the contract can reach, then
 * the rest that can still be picked, then the ones that cannot. The picker
 * lists the first three groups and shows the last only to a search.
 */
function ordered(options: readonly AssetOption[]): AssetOption[] {
  const position = new Map(options.map((option, index) => [option.key, index]));
  const group = (option: AssetOption): number =>
    option.disabledReason !== null ? 3 : option.held ? 0 : option.executable === "yes" ? 1 : 2;
  return [...options].sort((a, b) => {
    const step = group(a) - group(b);
    if (step !== 0) return step;
    if (a.held !== b.held) return a.held ? -1 : 1;
    if (a.held) return (position.get(a.key) ?? 0) - (position.get(b.key) ?? 0);
    return byTicker(a, b);
  });
}

/**
 * Everything the wallet can ask a swap to deliver, one row per
 * `${chainId}:${denom}`, from four sources:
 * 1. the held balances;
 * 2. the staking coin of every bundled chain on the From's network;
 * 3. the Osmosis rows of {@link BuyOptionsInput.osmosis}, delivered on Osmosis;
 * 4. each of those delivered home to its issuer (see `deliveryOf`).
 *
 * Only the From's network is shown: a mainnet From lists no testnet row, and
 * the reverse. A token nothing identifies is offered only when held.
 *
 * Each row is gated against the From with the route table
 * (lib/xcs-routes.ts `gateOptions`): a row that cannot be picked carries its
 * reason and is search-only. Order: held, then reachable, then the rest.
 */
export function buyOptions(
  chains: readonly SwapChain[],
  balances: Readonly<Record<string, HeldBalance | undefined>>,
  input: BuyOptionsInput = {},
): AssetOption[] {
  const osmosis = input.osmosis ?? [];
  const listed = listedDecimals(osmosis);
  const from = input.from ?? null;
  const testnet = from?.testnet ?? false;
  const rows = new Map<string, AssetOption>();
  const add = (option: AssetOption) => {
    if (rows.has(option.key) || option.testnet !== testnet) return;
    if (!option.held && option.identity.provenance === "unknown") return;
    rows.set(option.key, option);
  };
  const addRow = (row: RowInput) => {
    if (!rows.has(`${row.chainId}:${row.denom}`)) add(toOption(row, listed));
  };

  for (const option of sellOptions(chains, balances, osmosis)) add(option);
  for (const entry of allCatalogEntries()) {
    if ((entry.network === "testnet") !== testnet) continue;
    addRow({ chainId: entry.chainId, denom: entry.coinMinimalDenom, amount: "0", held: false });
  }
  if (!testnet) {
    for (const asset of osmosis) addRow({ chainId: VENUE, denom: asset.denom, amount: "0", held: false });
    for (const asset of osmosis) {
      const delivery = deliveryOf(asset);
      if (delivery) addRow(delivery);
    }
  }

  const gated = gateOptions(from, [...rows.values()], input.routes).map((option) => ({
    ...option,
    searchOnly: option.disabledReason !== null,
  }));
  return ordered(gated);
}

/**
 * The searchable half of a picker row: the ticker, the identity line
 * (`Native on Injective`, `Injective USDC · on Osmosis`), every name a search
 * should find (aliases such as `USDC.noble`, both chains, both denoms), and
 * whether it can be picked. For tests and code outside React: the popup builds
 * its rows with `tokenPickerItem(option.identity, …)`
 * (entrypoints/popup/components/TokenLabel.tsx), which has the same id, label
 * and words plus the logo, the balance and the Testnet or Custom tag.
 */
export function pickerFields(option: AssetOption): Searchable & { disabledReason?: string } {
  return {
    id: option.key,
    label: option.identity.ticker,
    sublabel: tokenText(option.identity, "row"),
    keywords: tokenKeywords(option.identity),
    disabled: option.disabledReason !== null,
    ...(option.disabledReason !== null ? { disabledReason: option.disabledReason } : {}),
    searchOnly: option.searchOnly,
  };
}

/**
 * What `planSwap` should find on the venue for this pair: the From's denom
 * on Osmosis (the held denom there, else its canonical voucher) and the To's.
 * Spread into the plan input; a side the identity cannot name is left out,
 * which skips that half of the planner's check.
 */
export function expectedVenueDenoms(
  from: Pick<AssetOption, "chainId" | "denom" | "identity">,
  to: Pick<AssetOption, "chainId" | "denom" | "identity">,
): { expectedVenueInputDenom?: string; expectedVenueOutputDenom?: string } {
  const input = osmosisDenomFor(from);
  const output = osmosisDenomFor(to);
  return {
    ...(input ? { expectedVenueInputDenom: input } : {}),
    ...(output ? { expectedVenueOutputDenom: output } : {}),
  };
}
