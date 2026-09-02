/** Display helpers shared by every popup screen. */

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

/** Base units (uatom) to a compact human string (2 decimals, k/M/Bn). */
export function formatUnits(
  amount: string,
  decimals: number,
  _maxFractionDigits = 2,
): string {
  return formatCompact(baseUnitsToNumber(amount, decimals), 2);
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

/** Placeholder used everywhere a real number is not available yet. */
export const NO_VALUE = "—";

/** Replace a rendered amount with dots when the user hides balances. */
export function maskAmount(value: string, hidden: boolean): string {
  return hidden ? "••••" : value;
}

export function isBech32(address: string): boolean {
  return /^[a-z0-9]+1[02-9ac-hj-np-z]{20,}$/.test(address.trim());
}

export function prefixOf(address: string): string {
  return address.split("1")[0] ?? "";
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
