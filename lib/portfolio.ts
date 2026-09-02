/**
 * Turns per-chain base-unit balances plus spot prices into fiat values.
 *
 * Every field is optional at the source: a chain may have no price id, an
 * endpoint may be down, or live reads may be off entirely. Rather than guess,
 * the totals report how many chains they actually cover so the UI can say so.
 */

import type { ChainBalance } from "./balances";
import type { PriceMap } from "./prices";

export interface ChainValue {
  chainId: string;
  /** Whole-coin amount across available + staked + rewards. */
  amount: number;
  /** Fiat value, or null when the chain has no price. */
  value: number | null;
  change24h: number | null;
}

export interface PortfolioTotals {
  /** Summed fiat value of every priced chain. */
  total: number;
  staked: number;
  claimable: number;
  /** Weighted 24h change across priced chains, or null when nothing priced. */
  change24h: number | null;
  /** Chains that contributed a fiat value. */
  pricedChains: number;
  /** Chains that had a balance but no price. */
  unpricedChains: number;
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

export function computePortfolio(
  balances: Record<string, ChainBalance>,
  prices: PriceMap,
): PortfolioTotals {
  const byChain: ChainValue[] = [];
  let total = 0;
  let staked = 0;
  let claimable = 0;
  let weightedChange = 0;
  let pricedChains = 0;
  let unpricedChains = 0;

  for (const balance of Object.values(balances)) {
    const { decimals } = balance;
    const available = toWholeCoins(balance.available, decimals);
    const stakedCoins = toWholeCoins(balance.staked, decimals);
    const rewards = toWholeCoins(balance.rewards, decimals);
    const amount = available + stakedCoins + rewards;

    const spot = prices[balance.chainId];
    if (!spot) {
      if (amount > 0) unpricedChains += 1;
      byChain.push({
        chainId: balance.chainId,
        amount,
        value: null,
        change24h: null,
      });
      continue;
    }

    const value = amount * spot.price;
    total += value;
    staked += stakedCoins * spot.price;
    claimable += rewards * spot.price;
    weightedChange += value * spot.change24h;
    pricedChains += 1;

    byChain.push({
      chainId: balance.chainId,
      amount,
      value,
      change24h: spot.change24h,
    });
  }

  byChain.sort((a, b) => (b.value ?? -1) - (a.value ?? -1));

  return {
    total,
    staked,
    claimable,
    change24h: total > 0 ? weightedChange / total : null,
    pricedChains,
    unpricedChains,
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
