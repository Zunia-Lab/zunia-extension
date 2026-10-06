/** Display helpers shared by every popup screen. */

import { bech32PrefixOf, isValidBech32Address } from "@zunialab/interchain";

/**
 * Digits and one decimal point. Letters, signs, and extra dots are dropped,
 * so an amount field cannot hold anything `toBaseUnits` would reject.
 */
export function decimalText(value: string): string {
  let seenDot = false;
  let out = "";
  for (const char of value) {
    if (char >= "0" && char <= "9") {
      out += char;
      continue;
    }
    if (char === "." && !seenDot) {
      seenDot = true;
      out += ".";
    }
  }
  return out;
}

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
 * Not compact: callers parse this back to base units.
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

/** True when the compact display would read as 0 / 0.00. */
export function displaysAsZero(
  amount: string,
  decimals: number,
  maxFractionDigits = 2,
): boolean {
  return (
    Number.parseFloat(formatUnits(amount, decimals, maxFractionDigits)) === 0
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

/**
 * One coin's price, with the digits a small price needs: two decimals from 1
 * up, else four significant digits, so SAF reads `$0.00028`, not `$0.00`.
 */
export function formatFiatPrice(value: number, currency: string): string {
  if (!Number.isFinite(value) || value <= 0) return formatFiat(0, currency);
  if (value >= 1) return formatFiat(value, currency);
  const symbol =
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
      currencyDisplay: "narrowSymbol",
    })
      .formatToParts(0)
      .find((part) => part.type === "currency")?.value ?? "$";
  const digits = new Intl.NumberFormat("en-US", {
    maximumSignificantDigits: 4,
    maximumFractionDigits: 12,
  }).format(value);
  return `${symbol}${digits}`;
}

/**
 * The one short form of a denom, for every surface (`lib/token-identity.ts`
 * re-exports it): `ibc/498A…6BA6E4` for a voucher, `erc20:0xa00C…235a` and
 * `peggy0xdAC1…1ec7` for bridged ERC-20s, a clipped factory path, else the
 * denom. Display only: the full denom stays one copy away.
 */
export function shortDenom(denom: string): string {
  if (denom.startsWith("factory/")) {
    const parts = denom.split("/");
    const sub = parts[parts.length - 1] ?? denom;
    const creator = parts[1] ?? "";
    const clipped =
      creator.length > 12 ? `${creator.slice(0, 6)}…${creator.slice(-4)}` : creator;
    return clipped ? `factory/${clipped}/${sub}` : denom;
  }
  if (denom.startsWith("ibc/")) {
    return denom.length <= 20 ? denom : `ibc/${denom.slice(4, 8)}…${denom.slice(-6)}`;
  }
  const bridged = /^(erc20:0x|peggy0x|gravity0x)([0-9a-fA-F]{12,})$/.exec(denom);
  if (bridged) return `${bridged[1]}${bridged[2].slice(0, 4)}…${bridged[2].slice(-4)}`;
  return denom;
}

/** `cosmos1qy35…hx9f2k` for a long address; short ones are left whole. */
export function shortAddress(address: string): string {
  return address.length > 22 ? `${address.slice(0, 12)}…${address.slice(-6)}` : address;
}

/** Placeholder used everywhere a real number is not available yet. */
export const NO_VALUE = "-";

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

/** `in 3 d`: {@link relativeTime} for a moment still ahead. */
export function timeUntil(timestamp: number): string {
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  if (seconds < 60) return "in under a minute";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours} h`;
  return `in ${Math.round(hours / 24)} d`;
}
