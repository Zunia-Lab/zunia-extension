/**
 * One amount policy for every token surface.
 *
 * Screens used to choose their own precision (2, 3 or 6 decimals, compact or
 * exact), so one balance read differently on Home, Swap and Activity. Worse, a
 * voucher whose decimals nobody knew reached the compact formatter with 0
 * decimals: 12340000 base units read as "12.34M", which looks like twelve
 * million tokens. Here the precision follows the kind of surface, and a token
 * whose decimals are not known (`decimalsKnown` false) is shown as raw base
 * units, never scaled and never compacted.
 *
 * Digits come from integer arithmetic on the base units, never from a float:
 * 18-decimal balances routinely exceed what a double holds exactly, and a
 * float prints large values with an exponent ("1e+21").
 *
 * Display only. A typed amount becomes base units through the token's
 * decimals, so without known decimals nothing typed can be converted: only Max
 * (the exact raw balance) is offered, see {@link canTypeAmount} and
 * {@link amountFieldText}.
 */

import { maskAmount, shortDenom } from "./format";
import type { TokenIdentity } from "./token-identity";

/**
 * Where an amount is shown.
 * - `list`: balance rows (Home, Chain detail). Two decimals, k/M/Bn allowed.
 * - `picker`: a picker row's balance. Exact, up to six decimals.
 * - `confirm`: review and confirm screens, and a transaction's detail.
 *   Exact, up to six decimals.
 * - `history`: activity rows and notices. Up to three decimals, k/M/Bn allowed.
 */
export type TokenAmountVariant = "list" | "picker" | "confirm" | "history";

/** What an amount needs from an identity; a full {@link TokenIdentity} fits. */
export type AmountIdentity = Pick<
  TokenIdentity,
  "decimals" | "decimalsKnown" | "ticker" | "denom" | "provenance"
>;

export interface TokenAmountOptions {
  /** The user hides balances: the whole text is masked, unit included. */
  readonly hidden?: boolean;
  /** Append the unit: the ticker, or the short denom when the token is unknown. */
  readonly unit?: boolean;
}

interface Precision {
  /** Fraction digits shown at most. Digits beyond are cut, never rounded up. */
  readonly digits: number;
  /** k / M / Bn for a thousand and more: rows scan by magnitude. */
  readonly compact: boolean;
  /**
   * Keep trailing zeros, so a column of balances lines up (`12.50`). Otherwise
   * they are trimmed (`12.5`, `12`), the way an amount reads in a sentence.
   */
  readonly pad: boolean;
}

/**
 * Every variant cuts instead of rounding, so no surface shows more than there
 * is: a balance of 0.999 never reads 1.00 on Home and then fails at Max, and a
 * confirm screen never states more than is signed.
 */
const PRECISION: Readonly<Record<TokenAmountVariant, Precision>> = {
  list: { digits: 2, compact: true, pad: true },
  picker: { digits: 6, compact: false, pad: false },
  confirm: { digits: 6, compact: false, pad: false },
  history: { digits: 3, compact: true, pad: false },
};

/** Compact units, largest first: the exponent each one stands for. */
const COMPACT_UNITS: ReadonlyArray<readonly [suffix: string, exponent: number]> = [
  ["Bn", 9],
  ["M", 6],
  ["k", 3],
];

/** The words after a raw amount whose decimals are unknown. */
export const BASE_UNITS = "base units";

/** Beside an amount field that cannot take typed input. */
export const MAX_ONLY_NOTE = "This token's decimals are unknown, so only Max can be used.";

/** A signed integer in canonical form (`-0012` is `-12`), or null when `amount` is not one. */
function integerText(amount: string | bigint): string | null {
  if (typeof amount === "bigint") return amount.toString();
  const text = amount.trim();
  return /^-?\d+$/.test(text) ? BigInt(text).toString() : null;
}

/** A display exponent fit for integer arithmetic; anything else counts as 0. */
function exponentOf(decimals: number): number {
  return Number.isSafeInteger(decimals) && decimals > 0 ? decimals : 0;
}

/**
 * `units` (not negative) divided by 10^`exponent`: the whole part, and the
 * fraction's first `digits` digits, cut and zero-padded to exactly `digits`.
 */
function cutDecimal(
  units: bigint,
  exponent: number,
  digits: number,
): { whole: bigint; fraction: string } {
  const scale = 10n ** BigInt(exponent);
  const whole = units / scale;
  const fraction = exponent > 0 ? (units % scale).toString().padStart(exponent, "0") : "";
  return { whole, fraction: fraction.slice(0, digits).padEnd(digits, "0") };
}

/**
 * The magnitude part of a known-decimals amount, without its sign. A non-zero
 * amount that would read as zero at this precision reads `<0.001` (with the
 * variant's digits) instead: a dust balance or a tiny fee is never shown as
 * nothing.
 */
function scaledText(units: bigint, decimals: number, precision: Precision): string {
  const exponent = exponentOf(decimals);
  let suffix = "";
  let shift = 0;
  if (precision.compact) {
    const whole = units / 10n ** BigInt(exponent);
    for (const [unit, unitExponent] of COMPACT_UNITS) {
      if (whole >= 10n ** BigInt(unitExponent)) {
        suffix = unit;
        shift = unitExponent;
        break;
      }
    }
  }
  const { whole, fraction } = cutDecimal(units, exponent + shift, precision.digits);
  if (units > 0n && whole === 0n && !/[1-9]/.test(fraction)) {
    return precision.digits > 0 ? `<0.${"0".repeat(precision.digits - 1)}1` : "<1";
  }
  const shown = precision.pad ? fraction : fraction.replace(/0+$/, "");
  return `${whole}${shown ? `.${shown}` : ""}${suffix}`;
}

/**
 * The unit after an amount: the ticker, or the short denom for a token nothing
 * names (`ibc/498A…6BA6E4` says more than `IBC·498A`, and is what the history
 * of an unnamed voucher has always shown).
 */
export function amountUnit(identity: Pick<AmountIdentity, "ticker" | "denom" | "provenance">): string {
  return identity.provenance === "unknown" ? shortDenom(identity.denom) : identity.ticker;
}

/**
 * `amount` (base units, optionally signed) as the surface shows it:
 * `12.34`, `20.34k`, `1234.567891`, `-12.34`, `<0.001`, or `12340000 base
 * units` when the decimals are unknown. With `unit`: `12.34 USDC.n`,
 * `12340000 base units ibc/498A…6BA6E4`. Text that is not an integer reads
 * as 0, as the formatters in lib/format.ts treat it.
 */
export function formatTokenAmount(
  amount: string | bigint,
  identity: AmountIdentity,
  variant: TokenAmountVariant,
  options: TokenAmountOptions = {},
): string {
  if (options.hidden) return maskAmount("", true);
  const raw = integerText(amount) ?? "0";
  let value: string;
  if (!identity.decimalsKnown) {
    value = `${raw} ${raw === "1" || raw === "-1" ? "base unit" : BASE_UNITS}`;
  } else {
    const negative = raw.startsWith("-");
    const units = BigInt(negative ? raw.slice(1) : raw);
    value = `${negative ? "-" : ""}${scaledText(units, identity.decimals, PRECISION[variant])}`;
  }
  return options.unit ? `${value} ${amountUnit(identity)}` : value;
}

/**
 * The text an amount field holds for `amount` base units, which is what Max
 * writes: every digit of the token's exponent, no grouping, no k/M, no
 * exponent notation. Converted back with the same `decimals` (the screens'
 * `toBaseUnits(text, decimals)`), it gives `amount` exactly, however large.
 * When the decimals are unknown `decimals` is 0 (the TokenIdentity and
 * AssetOption contract), so the field holds the raw integer it will sign.
 *
 * Use this rather than formatUnitsExact for a field: that one goes through a
 * float, so an 18-decimal balance above 2^53 base units came back as a
 * different number (1234567890123456789 as 1234567890123456800, more than is
 * held) and one above 10^21 as "1.2e+21", which the field cannot parse.
 * Text that is not a non-negative integer gives "0".
 */
export function amountFieldText(
  amount: string | bigint,
  scale: Pick<TokenIdentity, "decimals">,
): string {
  const raw = integerText(amount);
  if (raw === null || raw.startsWith("-")) return "0";
  const exponent = exponentOf(scale.decimals);
  const { whole, fraction } = cutDecimal(BigInt(raw), exponent, exponent);
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : `${whole}`;
}

/**
 * Whether the user may type an amount of this token. Typed text is converted
 * with the token's decimals; when they are unknown a typed "1.5" has no
 * meaning in base units, so the field takes only Max, the exact balance.
 */
export function canTypeAmount(identity: Pick<TokenIdentity, "decimalsKnown">): boolean {
  return identity.decimalsKnown;
}
