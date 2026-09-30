/**
 * Shared gas-fee maths for every wallet transaction.
 *
 * Max-send and IBC swaps spend the same denom the chain charges as gas. The
 * chain deducts the fee first, then the message; sending the full spendable
 * balance is how we get `insufficient funds` with a few thousand base units
 * of gap. Reservations here are the amount that must stay behind.
 */

import { feeTicker, findCatalogEntry } from "./chain-catalog";
import type { FeeSpeedPref } from "./settings";

export const FEE_SPEEDS: readonly { id: FeeSpeedPref; label: string }[] = [
  { id: "low", label: "Low" },
  { id: "average", label: "Mid" },
  { id: "high", label: "High" },
];

/** Conservative gas used when the form has not simulated yet (swap / IBC). */
export const RESERVE_GAS_LIMIT = 300_000;

export interface FeePrefs {
  readonly feeSpeed: FeeSpeedPref;
  readonly gasAdjustment: number;
}

export interface PrefFee {
  readonly amount: bigint;
  readonly denom: string;
  readonly decimals: number;
  readonly symbol: string;
}

function ceilMul(gasLimit: bigint, price: number, adjustment: number): bigint {
  // Keep the same "never round down" rule as the engine's estimateFee.
  const scaled = Math.ceil(Number(gasLimit) * price * adjustment);
  if (!Number.isFinite(scaled) || scaled <= 0) return 1n;
  return BigInt(scaled);
}

export function prefFeeFor(
  chainId: string,
  gasLimit: number,
  prefs: FeePrefs,
): PrefFee | null {
  const entry = findCatalogEntry(chainId);
  if (!entry) return null;
  const price = entry.gasPriceStep?.[prefs.feeSpeed];
  if (price === undefined || !Number.isFinite(price) || price < 0) return null;
  const denom = entry.feeMinimalDenom || entry.coinMinimalDenom;
  const amount = ceilMul(BigInt(Math.max(1, gasLimit)), price, prefs.gasAdjustment);
  return {
    amount,
    denom,
    decimals: entry.feeDecimals ?? entry.coinDecimals,
    symbol: feeTicker(entry),
  };
}

/** Base units that must stay in the account when `spendDenom` pays gas. */
export function reservedFeeUnits(
  chainId: string,
  spendDenom: string,
  prefs: FeePrefs,
  gasLimit = RESERVE_GAS_LIMIT,
): bigint {
  const fee = prefFeeFor(chainId, gasLimit, prefs);
  if (!fee || fee.denom !== spendDenom) return 0n;
  return fee.amount;
}

export function maxSendable(available: bigint, reserved: bigint): bigint {
  if (available <= reserved) return 0n;
  return available - reserved;
}
