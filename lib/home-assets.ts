/**
 * Flat spendable-asset rows for Home.
 *
 * One row per denom on an enabled chain: native coins always, plus any IBC,
 * factory, or other bank balance the address actually holds. Pricing uses the
 * holding chain for natives and the origin chain for IBC when that chain is
 * already in the price map.
 */

import { findCatalogByMinimalDenom } from "./chain-catalog";
import type { ChainBalance, TokenBalance, TokenKind } from "./balances";
import { shortDenom } from "./format";
import { toWholeCoins } from "./portfolio";
import type { PriceMap, SpotPrice } from "./prices";

export function tokenKindLabel(kind: TokenKind): string {
  if (kind === "ibc") return "IBC";
  if (kind === "factory") return "Factory";
  if (kind === "other") return "Asset";
  return "Native";
}

export interface HomeAsset {
  readonly key: string;
  readonly chainId: string;
  readonly chainName: string;
  readonly chainIconUrl?: string;
  readonly testnet: boolean;
  readonly token: TokenBalance;
  readonly kindLabel: string;
  readonly subtitle: string;
  readonly fiatValue: number | null;
  readonly change24h: number | null;
}

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

export function assetSubtitle(token: TokenBalance, chainName: string): string {
  if (token.kind === "ibc") {
    if (token.originChainName && token.originChainName !== chainName) {
      return `${chainName} · ${token.originChainName}`;
    }
    return `${chainName} · IBC`;
  }
  if (token.kind === "factory") {
    return `${chainName} · ${shortDenom(token.denom)}`;
  }
  if (token.kind === "other") {
    return `${chainName} · ${shortDenom(token.baseDenom ?? token.denom)}`;
  }
  return chainName;
}

export function tokenSpotPrice(
  token: TokenBalance,
  holdingChainId: string,
  prices: PriceMap,
): SpotPrice | undefined {
  if (token.kind === "native") return prices[holdingChainId];
  const base = token.baseDenom;
  if (!base) return undefined;
  const origin = findCatalogByMinimalDenom(base);
  return origin ? prices[origin.chainId] : undefined;
}

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
): HomeAsset {
  const spot = tokenSpotPrice(token, chain.chainId, prices);
  const coins = toWholeCoins(token.amount, token.decimals);
  return {
    key: `${chain.chainId}:${token.denom}`,
    chainId: chain.chainId,
    chainName: chain.chainName,
    ...(chain.iconUrl ? { chainIconUrl: chain.iconUrl } : {}),
    testnet: chain.network === "testnet",
    token,
    kindLabel: tokenKindLabel(token.kind),
    subtitle: assetSubtitle(token, chain.chainName),
    fiatValue: spot ? coins * spot.price : null,
    change24h: token.kind === "native" ? (spot?.change24h ?? null) : null,
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
  return a.token.symbol.localeCompare(b.token.symbol);
}

/**
 * Every native of an enabled chain, plus each non-zero IBC / factory / other
 * holding. Zero natives stay so a network with no balance is still findable.
 */
export function homeAssets(
  chains: readonly HomeAssetChain[],
  balances: Readonly<Record<string, ChainBalance>>,
  prices: PriceMap,
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
    out.push(toAsset(chain, native, prices));
    for (const token of tokens) {
      if (token.kind === "native" || token.amount === "0") continue;
      out.push(toAsset(chain, token, prices));
    }
  }
  return out.sort(compareAssets);
}

/** Subtitle when the chain name is already on the group header. */
export function groupedSubtitle(token: TokenBalance): string {
  if (token.kind === "ibc") return token.originChainName ?? "IBC";
  if (token.kind === "factory") return shortDenom(token.denom);
  if (token.kind === "other") return shortDenom(token.baseDenom ?? token.denom);
  return "Native";
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
