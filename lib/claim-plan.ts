/**
 * Which validators a "claim all" withdraws from, and the gas fallback for them.
 */
import type { DelegationInfo } from "./chain-queries";

/** Most withdraw messages one transaction carries; the rest stay claimable. */
export const MAX_CLAIM_MSGS = 20;
/** Gas per withdraw message when no simulation is available (live simulation: 71k Safrochain, 129k Injective, 233k Osmosis, 320k Cosmos Hub per message). */
export const GAS_PER_CLAIM_MSG = 350_000;

type Row = Pick<DelegationInfo, "validatorAddress" | "rewards" | "otherRewards">;

/** True when a position has anything to withdraw, in any denom. */
export function hasClaimable(d: Pick<DelegationInfo, "rewards" | "otherRewards">): boolean {
  if (BigInt(d.rewards || "0") > 0n) return true;
  return (d.otherRewards ?? []).some((c) => BigInt(c.amount || "0") > 0n);
}

/** Validators to claim from: biggest staking-denom rewards first, capped, no duplicates. */
export function claimTargets<T extends Row>(rows: readonly T[]): { targets: T[]; skipped: number } {
  const seen = new Set<string>();
  const all = rows
    .filter((d) => d.validatorAddress && hasClaimable(d) && !seen.has(d.validatorAddress) && seen.add(d.validatorAddress))
    .sort((a, b) => {
      const x = BigInt(a.rewards || "0");
      const y = BigInt(b.rewards || "0");
      return x === y ? 0 : x > y ? -1 : 1;
    });
  return { targets: all.slice(0, MAX_CLAIM_MSGS), skipped: Math.max(0, all.length - MAX_CLAIM_MSGS) };
}

export function claimFallbackGas(count: number): number {
  return Math.max(400_000, count * GAS_PER_CLAIM_MSG);
}
