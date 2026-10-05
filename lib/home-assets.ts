/**
 * Home's asset rows, and the words, prices and totals they show.
 *
 * One row per denom on an enabled chain: the chain's staking coin always (a
 * zero one too, so a network with no balance is still findable), plus every
 * other non-zero bank balance. Each row carries the TokenIdentity it is shown
 * with, from `heldTokenIdentity` (lib/balances.ts): what the token is and
 * where it sits (`USDC.n` · `Noble USDC · on Osmosis`), and the decimals its
 * amount is shown with, the same ones Send converts a typed amount with.
 *
 * A row is priced through that identity only. The price map is keyed by chain
 * and quotes each chain's own coin, so a token takes a chain's price only when
 * it is exactly that coin (see {@link priceChainOf}). Nothing is priced by its
 * base denom: `uusdc` is Noble's coin and Axelar's bridged USDC alike, and
 * `wei` is Ethereum's unit as well as Stratos's coin. A token whose decimals
 * are unknown is never valued: its amount cannot be scaled.
 */

import { heldTokenIdentity, type ChainBalance, type TokenBalance, type TokenKind } from "./balances";
import { currenciesOf, findCatalogEntry, type CatalogEntry } from "./chain-catalog";
import { activityAmount as historyAmount, type ActivityItem, type HeldBalances } from "./chain-queries";
import { shortDenom } from "./format";
import { toWholeCoins, type AssetValue } from "./portfolio";
import type { PriceMap, SpotPrice } from "./prices";
import { formatTokenAmount } from "./token-amount";
import { familyOf, tokenKindLabel, tokenText, type TokenIdentity } from "./token-identity";

export interface HomeAsset {
  readonly key: string;
  readonly chainId: string;
  readonly chainName: string;
  readonly chainIconUrl?: string;
  readonly testnet: boolean;
  readonly token: TokenBalance;
  /**
   * What the row shows: `heldTokenIdentity(chainId, token)` (through the
   * screen's {@link HeldIdentify}), so the ticker, badge, seal and subtitle
   * come from the identity and the amount uses the decimals Send converts
   * with. Pass it to TokenAvatar, TokenLabel and formatTokenAmount; never
   * format `token.amount` with anything else.
   */
  readonly identity: TokenIdentity;
  /** `IBC`, `Factory`, `ERC-20`: the identity's kind, a search word. */
  readonly kindLabel: string;
  /** {@link assetSubtitle}: `Noble USDC · on Osmosis`, `Native on Injective`. */
  readonly subtitle: string;
  /** Fiat value, or null when no trusted price applies ({@link priceChainOf}). */
  readonly fiatValue: number | null;
  /** The priced coin's 24h change, null when the row is not priced. */
  readonly change24h: number | null;
}

/**
 * Names a held row: `heldTokenIdentity` (lib/balances.ts) by default. A
 * screen passes its own copy, replaced whenever newly proven token facts
 * land, so the rows it memoizes are named again with them.
 */
export type HeldIdentify = (
  chainId: string,
  token: Pick<TokenBalance, "denom" | "decimals" | "decimalsKnown">,
) => TokenIdentity;

export interface HomeAssetChain {
  readonly chainId: string;
  readonly chainName: string;
  readonly network: "mainnet" | "testnet";
  readonly coinDenom: string;
  readonly coinMinimalDenom: string;
  readonly coinDecimals: number;
  readonly iconUrl?: string;
  readonly inCosmosRegistry?: boolean;
}

/* -------------------------------------------------------------------------- *
 * Words
 * -------------------------------------------------------------------------- */

/**
 * A row's subtitle when it stands alone: what the token is and where it sits,
 * in the identity's words. `Native on Injective`, `Noble USDC · on Osmosis`,
 * `Alloyed USDC · Osmosis only`, `Unknown origin · on Osmosis · ibc/498A…6BA6E4`.
 */
export function assetSubtitle(identity: TokenIdentity): string {
  return tokenText(identity, "row");
}

/** The staking coin of `chainId`, as the catalog lists it. */
function stakingDenomOf(chainId: string): string | undefined {
  return findCatalogEntry(chainId)?.coinMinimalDenom;
}

/**
 * A row's subtitle under a header that already names the chain (Home's
 * grouped list, a chain's own page): {@link assetSubtitle} without the
 * location. The chain's own staking coin needs none. Any other token reads by
 * its name (`Noble USDC`, `Injective USDC`, `Alloyed USDC`, `Unlisted Osmosis
 * token`); a token nothing identifies keeps its short denom, the one thing
 * that tells it apart.
 */
export function groupedSubtitle(identity: TokenIdentity): string | null {
  if (identity.provenance === "unknown") {
    return `Unknown origin · ${shortDenom(identity.denom)}`;
  }
  const home = identity.originChainId === identity.heldOnChainId;
  if (home && identity.denom === stakingDenomOf(identity.heldOnChainId)) return null;
  return identity.name;
}

/* -------------------------------------------------------------------------- *
 * Prices
 * -------------------------------------------------------------------------- */

/**
 * Whether `denom` is the coin `entry`'s price quotes. The catalog's price id
 * describes the chain's staking coin; its fee coin counts only when the
 * catalog gives that coin the same price id. AtomOne pays fees in PHOTON,
 * another asset than ATONE, so PHOTON never takes ATONE's price.
 */
function quotes(entry: CatalogEntry, denom: string): boolean {
  if (denom === entry.coinMinimalDenom) return true;
  if (denom !== entry.feeMinimalDenom) return false;
  const fee = currenciesOf(entry).find((currency) => currency.coinMinimalDenom === denom);
  return fee?.coinGeckoId !== undefined && fee.coinGeckoId === entry.coinGeckoId;
}

/**
 * The chain whose spot price is `identity`'s, or null when no trusted price
 * applies. The price map quotes each chain's own coin, so:
 * - the holding chain's staking coin takes the holding chain's price, as the
 *   chain's other figures do (staked, rewards, the chain's page);
 * - any other token takes its origin chain's price only when the identity is
 *   proven and its exact origin denom is the coin that price quotes: ATOM on
 *   Osmosis takes the Hub's price, USDC.n anywhere takes Noble's;
 * - nothing else is priced. USDC.axl is Axelar's bridged USDC, neither
 *   Noble's coin nor AXL; ETH.pica unwinds to `wei` but is not Stratos's coin;
 *   an unproven walk could be a look-alike chain claiming a real chain's id.
 * Never when the decimals are unknown: the amount could not be scaled.
 */
export function priceChainOf(identity: TokenIdentity): string | null {
  if (!identity.decimalsKnown) return null;
  if (identity.denom === stakingDenomOf(identity.heldOnChainId)) return identity.heldOnChainId;
  const { originChainId, originDenom } = identity;
  if (!identity.proven || !originChainId || !originDenom) return null;
  const origin = findCatalogEntry(originChainId);
  if (!origin?.coinGeckoId) return null;
  // The quote is for the origin's price id: an identity naming another id is another asset.
  if (identity.coinGeckoId && identity.coinGeckoId !== origin.coinGeckoId) return null;
  return quotes(origin, originDenom) ? originChainId : null;
}

/** The spot price of a held row, through its identity ({@link priceChainOf}). */
export function tokenSpotPrice(
  token: Pick<TokenBalance, "denom" | "decimals" | "decimalsKnown">,
  holdingChainId: string,
  prices: PriceMap,
): SpotPrice | undefined {
  const chainId = priceChainOf(heldTokenIdentity(holdingChainId, token));
  return chainId ? prices[chainId] : undefined;
}

/* -------------------------------------------------------------------------- *
 * Rows
 * -------------------------------------------------------------------------- */

function nativePlaceholder(chain: HomeAssetChain): TokenBalance {
  return {
    denom: chain.coinMinimalDenom,
    amount: "0",
    kind: "native",
    symbol: chain.coinDenom,
    displayName: chain.coinDenom,
    decimals: chain.coinDecimals,
    ...(chain.iconUrl ? { iconUrl: chain.iconUrl } : {}),
    baseDenom: chain.coinMinimalDenom,
  };
}

function toAsset(
  chain: HomeAssetChain,
  token: TokenBalance,
  prices: PriceMap,
  identify: HeldIdentify,
): HomeAsset {
  const identity = identify(chain.chainId, token);
  const priceChain = priceChainOf(identity);
  const spot = priceChain ? prices[priceChain] : undefined;
  return {
    key: `${chain.chainId}:${token.denom}`,
    chainId: chain.chainId,
    chainName: chain.chainName,
    ...(chain.iconUrl ? { chainIconUrl: chain.iconUrl } : {}),
    testnet: chain.network === "testnet",
    token,
    identity,
    kindLabel: tokenKindLabel(identity.kind),
    subtitle: assetSubtitle(identity),
    fiatValue: spot ? toWholeCoins(token.amount, identity.decimals) * spot.price : null,
    change24h: spot ? spot.change24h : null,
  };
}

const KIND_RANK: Record<TokenKind, number> = {
  native: 0,
  ibc: 1,
  factory: 2,
  other: 3,
};

function compareAssets(a: HomeAsset, b: HomeAsset): number {
  const aZero = a.token.amount === "0";
  const bZero = b.token.amount === "0";
  if (aZero !== bZero) return aZero ? 1 : -1;
  const aFiat = a.fiatValue;
  const bFiat = b.fiatValue;
  if (aFiat !== null && bFiat !== null && aFiat !== bFiat) return bFiat - aFiat;
  if (aFiat !== null && bFiat === null) return -1;
  if (aFiat === null && bFiat !== null) return 1;
  const kind = KIND_RANK[a.token.kind] - KIND_RANK[b.token.kind];
  if (kind !== 0) return kind;
  return a.identity.ticker.localeCompare(b.identity.ticker);
}

/**
 * Every native of an enabled chain, plus each non-zero IBC / factory / other
 * holding. Zero natives stay so a network with no balance is still findable.
 */
export function homeAssets(
  chains: readonly HomeAssetChain[],
  balances: Readonly<Record<string, ChainBalance>>,
  prices: PriceMap,
  identify: HeldIdentify = heldTokenIdentity,
): HomeAsset[] {
  const out: HomeAsset[] = [];
  for (const chain of chains) {
    const balance = balances[chain.chainId];
    const tokens = balance?.tokens ?? [];
    const native =
      tokens.find((token) => token.kind === "native") ??
      (balance
        ? {
            denom: balance.denom,
            amount: balance.available,
            kind: "native" as const,
            symbol: balance.symbol,
            displayName: balance.symbol,
            decimals: balance.decimals,
            ...(balance.iconUrl ?? chain.iconUrl
              ? { iconUrl: balance.iconUrl ?? chain.iconUrl }
              : {}),
            baseDenom: balance.denom,
          }
        : nativePlaceholder(chain));
    out.push(toAsset(chain, native, prices, identify));
    for (const token of tokens) {
      if (token.kind === "native" || token.amount === "0") continue;
      out.push(toAsset(chain, token, prices, identify));
    }
  }
  return out.sort(compareAssets);
}

/**
 * The rows as the headline counts them (`computePortfolio`): each row's value
 * exactly as the row shows it, so the total is the sum of what Home lists.
 */
export function assetValues(assets: readonly HomeAsset[]): AssetValue[] {
  return assets.map((asset) => ({
    chainId: asset.chainId,
    staking: asset.token.kind === "native",
    // Base units: a positive integer is a balance, "0" (or anything else) is not.
    held: /^\d*[1-9]\d*$/.test(asset.token.amount),
    value: asset.fiatValue,
    change24h: asset.change24h,
  }));
}

export interface HomeAssetGroup {
  readonly chainId: string;
  readonly chainName: string;
  readonly chainIconUrl?: string;
  readonly testnet: boolean;
  readonly assets: readonly HomeAsset[];
  readonly spendable: number;
  readonly fiatValue: number | null;
}

/** Keep the enabled-chain order; drop empty groups. */
export function groupHomeAssets(
  assets: readonly HomeAsset[],
  chainOrder: readonly string[],
): HomeAssetGroup[] {
  const buckets = new Map<string, HomeAsset[]>();
  for (const asset of assets) {
    const list = buckets.get(asset.chainId) ?? [];
    list.push(asset);
    buckets.set(asset.chainId, list);
  }
  const order = [...chainOrder];
  for (const id of buckets.keys()) {
    if (!order.includes(id)) order.push(id);
  }
  return order.flatMap((chainId) => {
    const list = buckets.get(chainId);
    if (!list?.length) return [];
    const first = list[0]!;
    let fiat = 0;
    let priced = false;
    for (const asset of list) {
      if (asset.fiatValue === null) continue;
      fiat += asset.fiatValue;
      priced = true;
    }
    return [
      {
        chainId,
        chainName: first.chainName,
        ...(first.chainIconUrl ? { chainIconUrl: first.chainIconUrl } : {}),
        testnet: first.testnet,
        assets: list,
        spendable: list.filter((asset) => asset.token.amount !== "0").length,
        fiatValue: priced ? fiat : null,
      },
    ];
  });
}

/**
 * A balance row's amount under the shared `list` policy, as the figure and
 * the words after it: `12.34` alone, or `12340000` and `base units` for a token
 * whose decimals are unknown. A row stacks the two, in the line a price would
 * use (such a token is never priced), instead of letting a long raw amount
 * squeeze the row's subtitle.
 */
export function listAmount(
  amount: string,
  identity: Pick<TokenIdentity, "decimals" | "decimalsKnown" | "ticker" | "denom" | "provenance">,
  hidden: boolean,
): { readonly figure: string; readonly words: string | null } {
  return splitBaseUnits(formatTokenAmount(amount, identity, "list", { hidden }));
}

/** The words the shared policy (lib/token-amount.ts) puts after a raw amount. */
const BASE_UNIT_WORDS = / (base units?)$/;

/**
 * `12340000 base units` as its figure and words. The shared policy writes an
 * amount whose decimals are unknown as an integer, a space, then `base unit`
 * or `base units`; a scaled amount (or a masked one) has no words.
 */
function splitBaseUnits(text: string): { readonly figure: string; readonly words: string | null } {
  const words = BASE_UNIT_WORDS.exec(text);
  return words ? { figure: text.slice(0, words.index), words: words[1] ?? null } : { figure: text, words: null };
}

/* -------------------------------------------------------------------------- *
 * Activity
 * -------------------------------------------------------------------------- */

/** A history row's amount on Home and a chain's page, in the parts the row lays out. */
export interface ActivityAmountParts {
  /**
   * The signed number: `-12.34`, `+20.345k`, `+12340000`; unsigned for
   * staking, which moves value between the account's own balances (`1.5`).
   */
  readonly figure: string;
  /** `base units` (or `base unit`) when the decimals are unknown and the figure is raw, else null. */
  readonly words: string | null;
  /**
   * The unit: the ticker the row's title names (`USDC.n`), or the short denom
   * of a coin nothing names. Shaped for TokenTicker, which never cuts the
   * suffix. Null when the row names no unit.
   */
  readonly unit: { readonly ticker: string; readonly family: string } | null;
  /** All of it on one line, as the Activity screen writes it: `-12.34 USDC.n`. */
  readonly text: string;
}

/**
 * How a history row's amount reads on Home and a chain's page, or null when
 * the row moved nothing. The words come from the Activity screen's own
 * helper (`activityAmount` in lib/chain-queries.ts), so a row reads the same
 * on every screen: the same sign (none for staking), the same `history`
 * precision, and, for a held coin nothing names, the decimals its balance row
 * uses (`heldTokenIdentity`), so Home's activity never shows `12340000 base
 * units` of a token Home's asset list shows as `12.34`. This only splits that
 * text for layout: the figure, the `base units` words, the unit.
 */
export function activityAmountParts(
  item: Pick<
    ActivityItem,
    "chainId" | "kind" | "amount" | "denom" | "symbol" | "decimals" | "decimalsKnown" | "provenance"
  >,
  balances?: HeldBalances,
): ActivityAmountParts | null {
  if (!item.amount || !/[1-9]/.test(item.amount)) return null;
  const amount = historyAmount(item, "history", balances ? { balances } : {});
  if (!amount) return null;
  const { figure, words } = splitBaseUnits(amount.value);
  return {
    figure: `${amount.sign}${figure}`,
    words,
    unit: amount.unit ? { ticker: amount.unit, family: familyOf(amount.unit) } : null,
    text: amount.text,
  };
}
