/** Display helpers shared by every popup screen. */

import { bech32PrefixOf, isValidBech32Address } from "@zunialab/interchain";

/**
 * Compact magnitude: 2 decimals + k / M / Bn.
 * Examples: 20.34k, 1.50M, 2.10Bn, 12.50
 */
export function formatCompact(value: number, fractionDigits = 2): string {
  if (!Number.isFinite(value)) return "0.00";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) {
    return `${sign}${(abs / 1_000_000_000).toFixed(fractionDigits)}Bn`;
  }
  if (abs >= 1_000_000) {
    return `${sign}${(abs / 1_000_000).toFixed(fractionDigits)}M`;
  }
  if (abs >= 1_000) {
    return `${sign}${(abs / 1_000).toFixed(fractionDigits)}k`;
  }
  return `${sign}${abs.toFixed(fractionDigits)}`;
}

function baseUnitsToNumber(amount: string, decimals: number): number {
  let negative = false;
  let raw = amount.trim();
  if (raw.startsWith("-")) {
    negative = true;
    raw = raw.slice(1);
  }
  if (!raw || !/^\d+$/.test(raw)) return 0;
  const padded = raw.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals) || "0";
  const fraction = decimals > 0 ? padded.slice(padded.length - decimals) : "0";
  const value = Number(`${whole}.${fraction}`);
  if (!Number.isFinite(value)) return 0;
  return negative ? -value : value;
}

/**
 * Full-precision display for amount inputs (Send MAX, etc.).
 * Not compact — callers parse this back to base units.
 */
export function formatUnitsExact(
  amount: string,
  decimals: number,
  maxFractionDigits = decimals,
): string {
  let negative = false;
  let raw = amount.trim();
  if (raw.startsWith("-")) {
    negative = true;
    raw = raw.slice(1);
  }
  if (!raw || !/^\d+$/.test(raw)) return "0";
  const padded = raw.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals) || "0";
  const fraction = decimals > 0 ? padded.slice(padded.length - decimals) : "";
  const trimmed = fraction
    .slice(0, Math.max(0, maxFractionDigits))
    .replace(/0+$/, "");
  const value = trimmed ? `${Number(whole)}.${trimmed}` : `${Number(whole)}`;
  return negative ? `-${value}` : value;
}

/**
 * Base units (uatom) to a compact human string (k / M / Bn suffix).
 *
 * maxFractionDigits used to be accepted and then ignored, so every caller that
 * asked for 3 decimals (rewards, unbonding amounts) silently got 2 and rounded
 * small balances to "0.00". It is honoured now.
 */
export function formatUnits(
  amount: string,
  decimals: number,
  maxFractionDigits = 2,
): string {
  return formatCompact(
    baseUnitsToNumber(amount, decimals),
    Math.max(0, maxFractionDigits),
  );
}

export function formatFiat(value: number, currency: string): string {
  if (!Number.isFinite(value)) {
    return formatFiat(0, currency);
  }
  const sign = value < 0 ? "-" : "";
  const symbol =
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
      currencyDisplay: "narrowSymbol",
    })
      .formatToParts(0)
      .find((part) => part.type === "currency")?.value ?? "$";
  return `${sign}${symbol}${formatCompact(Math.abs(value), 2)}`;
}

/** `ibc/27394FB0…41E5EB2` for a voucher, the denom itself for anything else. */
export function shortDenom(denom: string): string {
  if (!denom.startsWith("ibc/") || denom.length <= 20) return denom;
  return `ibc/${denom.slice(4, 12)}…${denom.slice(-6)}`;
}

/** `cosmos1qy35…hx9f2k` for a long address; short ones are left whole. */
export function shortAddress(address: string): string {
  return address.length > 22 ? `${address.slice(0, 12)}…${address.slice(-6)}` : address;
}

/** Placeholder used everywhere a real number is not available yet. */
export const NO_VALUE = "—";

/** Replace a rendered amount with dots when the user hides balances. */
export function maskAmount(value: string, hidden: boolean): string {
  return hidden ? "••••" : value;
}

/**
 * A lowercase bech32 address with a valid checksum. A typo in one character
 * fails here instead of at signing. Prefixes may contain `_` (`addr_safro`).
 */
export function isBech32(address: string): boolean {
  const value = address.trim();
  return (
    value === value.toLowerCase() &&
    /1[02-9ac-hj-np-z]{20,}$/.test(value) &&
    isValidBech32Address(value)
  );
}

/** Everything before the last `1`, or "" when the text is not bech32-shaped. */
export function prefixOf(address: string): string {
  return bech32PrefixOf(address.trim().toLowerCase()) ?? "";
}

export function relativeTime(timestamp: number): string {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}
