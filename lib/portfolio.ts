/**
 * Turns per-chain base-unit balances plus spot prices into fiat values.
 *
 * Every field is optional at the source: a chain may have no price id, an
 * endpoint may be down, or live reads may be off entirely. Rather than guess,
 * the totals report how many held assets they actually cover so the UI can
 * say so.
 */

import type { ChainBalance } from "./balances";
import type { PriceMap } from "./prices";

export interface ChainValue {
  chainId: string;
  /** Whole-coin amount of the chain's own coin across available + staked + rewards. */
  amount: number;
  /** Fiat value of everything held on the chain, or null when none of it is priced. */
  value: number | null;
  /** 24h change of that value, weighted by what is priced, or null. */
  change24h: number | null;
}

/**
 * One of Home's asset rows, valued exactly as the row shows it
 * (lib/home-assets.ts prices each through its token identity), so the
 * headline is the sum of what Home lists.
 */
export interface AssetValue {
  /** The chain the balance is held on. */
  readonly chainId: string;
  /**
   * The chain's own staking coin. What the chain stakes and has earned is the
   * same coin and is counted with it, priced by the chain.
   */
  readonly staking: boolean;
  /** A non-zero balance. */
  readonly held: boolean;
  /** Fiat value of the balance, or null when no trusted price applies. */
  readonly value: number | null;
  readonly change24h: number | null;
}

export interface PortfolioTotals {
  /** Every priced asset row, plus what each priced chain stakes and has earned. */
  total: number;
  staked: number;
  claimable: number;
  /** Weighted 24h change across what is priced, or null when nothing is. */
  change24h: number | null;
  /** Chains whose own coin has a price, held or not: the total means something. */
  pricedChains: number;
  /**
   * Held assets in the total: each chain's own coin (counted once with what it
   * stakes and earns) and every other token with a price.
   */
  pricedAssets: number;
  /** Held assets left out of the total because no trusted price applies. */
  unpricedAssets: number;
  byChain: ChainValue[];
}

/** Base units to a float. Safe for display maths, not for signing. */
export function toWholeCoins(base: string, decimals: number): number {
  if (!base || base === "0") return 0;
  const negative = base.startsWith("-");
  const digits = (negative ? base.slice(1) : base).padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals > 0 ? digits.slice(digits.length - decimals) : "";
  const value = Number(`${whole}.${fraction || "0"}`);
  return negative ? -value : value;
}

interface ChainTally {
  amount: number;
  value: number;
  weighted: number;
  priced: boolean;
}

/**
 * Home's headline. `assets` are Home's rows (`assetValues` in
 * lib/home-assets.ts); a chain in `balances` without a staking row there is
 * valued from its balance instead, its available coin at the chain's price.
 * Staked and earned amounts are the chain's own coin, so they take the
 * chain's price. Unpriced holdings are left out and counted, never guessed.
 */
export function computePortfolio(
  balances: Record<string, ChainBalance>,
  prices: PriceMap,
  assets: readonly AssetValue[] = [],
): PortfolioTotals {
  const chains = new Map<string, ChainTally>();
  const tally = (chainId: string): ChainTally => {
    let entry = chains.get(chainId);
    if (!entry) {
      entry = { amount: 0, value: 0, weighted: 0, priced: false };
      chains.set(chainId, entry);
    }
    return entry;
  };
  let total = 0;
  let staked = 0;
  let claimable = 0;
  let weightedChange = 0;
  let pricedChains = 0;
  let pricedAssets = 0;
  let unpricedAssets = 0;

  const add = (chainId: string, value: number, change24h: number | null) => {
    const entry = tally(chainId);
    entry.value += value;
    entry.weighted += value * (change24h ?? 0);
    entry.priced = true;
    total += value;
    weightedChange += value * (change24h ?? 0);
  };

  const stakingRows = new Map<string, AssetValue>();
  for (const asset of assets) {
    if (asset.staking) {
      stakingRows.set(asset.chainId, asset);
      continue;
    }
    if (!asset.held) continue;
    if (asset.value === null) {
      unpricedAssets += 1;
      tally(asset.chainId);
      continue;
    }
    pricedAssets += 1;
    add(asset.chainId, asset.value, asset.change24h);
  }

  for (const balance of Object.values(balances)) {
    const { decimals } = balance;
    const spot = prices[balance.chainId];
    const available = toWholeCoins(balance.available, decimals);
    const stakedCoins = toWholeCoins(balance.staked, decimals);
    const rewards = toWholeCoins(balance.rewards, decimals);
    const entry = tally(balance.chainId);
    entry.amount = available + stakedCoins + rewards;
    if (spot) pricedChains += 1;

    // The coin as Home's row shows it, else from the balance.
    const row: AssetValue = stakingRows.get(balance.chainId) ?? {
      chainId: balance.chainId,
      staking: true,
      held: available > 0,
      value: spot ? available * spot.price : null,
      change24h: spot ? spot.change24h : null,
    };
    stakingRows.delete(balance.chainId);
    if (row.value !== null) add(balance.chainId, row.value, row.change24h);

    const position = stakedCoins + rewards;
    if (spot && position !== 0) {
      staked += stakedCoins * spot.price;
      claimable += rewards * spot.price;
      add(balance.chainId, position * spot.price, spot.change24h);
    }

    // The chain's coin is one asset, whether it sits available, staked or earning.
    if (row.held || position > 0) {
      if (row.value !== null || (spot && position > 0)) pricedAssets += 1;
      else unpricedAssets += 1;
    }
  }

  // Staking rows of chains with no balance read yet: a zero placeholder, or a
  // value the caller already has.
  for (const row of stakingRows.values()) {
    if (row.value !== null) add(row.chainId, row.value, row.change24h);
    if (!row.held) continue;
    if (row.value !== null) pricedAssets += 1;
    else unpricedAssets += 1;
  }

  const byChain: ChainValue[] = [...chains.entries()].map(([chainId, entry]) => ({
    chainId,
    amount: entry.amount,
    value: entry.priced ? entry.value : null,
    change24h: entry.priced && entry.value > 0 ? entry.weighted / entry.value : null,
  }));
  byChain.sort((a, b) => (b.value ?? -1) - (a.value ?? -1));

  return {
    total,
    staked,
    claimable,
    change24h: total > 0 ? weightedChange / total : null,
    pricedChains,
    pricedAssets,
    unpricedAssets,
    byChain,
  };
}

/**
 * Allocation slices for a donut, largest first, with everything below the
 * cutoff folded into a single "Other" slice so the chart stays readable.
 */
export function allocationSlices(
  totals: PortfolioTotals,
  maxSlices = 4,
): Array<{ chainId: string; share: number }> {
  const priced = totals.byChain.filter((c) => (c.value ?? 0) > 0);
  if (totals.total <= 0 || priced.length === 0) return [];

  const slices = priced
    .slice(0, maxSlices - 1)
    .map((c) => ({ chainId: c.chainId, share: (c.value ?? 0) / totals.total }));

  const rest = priced.slice(maxSlices - 1);
  if (rest.length > 0) {
    const share = rest.reduce((sum, c) => sum + (c.value ?? 0), 0) / totals.total;
    if (share > 0) slices.push({ chainId: "other", share });
  }
  return slices;
}
