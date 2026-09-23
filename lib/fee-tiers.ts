/**
 * Fee tiers a signing prompt may offer in place of the fee a site chose.
 *
 * Offered only when the site allows it (Keplr's `preferNoSetFee` is not set),
 * the fee is one coin in the chain's fee denom, and the catalog lists gas
 * prices for that denom. The site's own fee stays the default choice.
 */

import { findCatalogEntry } from "./chain-catalog";
import { coinDisplay } from "./coin-display";
import { ProtoWriter, lengthDelimitedField, readProtoFields } from "./proto";

export type FeeTier = "low" | "average" | "high";

export const FEE_TIERS: readonly FeeTier[] = ["low", "average", "high"];

export function isFeeTier(value: unknown): value is FeeTier {
  return value === "low" || value === "average" || value === "high";
}

export interface FeeCoin {
  denom: string;
  amount: string;
}

export interface TxFee {
  amount: FeeCoin[];
  gas: string;
}

export interface FeeChoice {
  denom: string;
  symbol: string;
  decimals: number;
  gas: string;
  /** Base units the site asked for. */
  site: string;
  tiers: Record<FeeTier, string>;
}

/** Keplr's sign options, as far as Zunia reads them. */
export interface SignOptions {
  preferNoSetFee: boolean;
}

export function signOptionsFrom(raw: unknown): SignOptions {
  const options = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return { preferNoSetFee: options.preferNoSetFee === true };
}

/** Catalog gas prices are floats; twelve decimals is finer than any of them. */
const PRICE_SCALE = 12;

/** `gas × price`, rounded up, in exact integer arithmetic. */
function priced(gas: bigint, price: number): string {
  if (!Number.isFinite(price) || price <= 0) return "0";
  const [whole = "0", fraction = ""] = price.toFixed(PRICE_SCALE).split(".");
  const scaled = BigInt(whole + fraction.padEnd(PRICE_SCALE, "0"));
  const unit = 10n ** BigInt(PRICE_SCALE);
  return ((gas * scaled + unit - 1n) / unit).toString();
}

const DIGITS = /^\d+$/;

/** The tiers to offer for this fee, or `null` when it cannot or may not change. */
export function feeChoiceFor(
  chainId: string,
  fee: TxFee | null,
  options: SignOptions,
): FeeChoice | null {
  if (options.preferNoSetFee || !fee) return null;
  const entry = findCatalogEntry(chainId);
  const step = entry?.gasPriceStep;
  if (!entry || !step) return null;
  const [coin, ...others] = fee.amount;
  if (!coin || others.length > 0 || coin.denom !== entry.feeMinimalDenom) return null;
  if (!DIGITS.test(coin.amount) || !DIGITS.test(fee.gas) || BigInt(fee.gas) === 0n) return null;
  const gas = BigInt(fee.gas);
  const display = coinDisplay(chainId, coin.denom);
  return {
    denom: coin.denom,
    symbol: display.symbol,
    decimals: display.decimals,
    gas: fee.gas,
    site: coin.amount,
    tiers: {
      low: priced(gas, step.low),
      average: priced(gas, step.average),
      high: priced(gas, step.high),
    },
  };
}

function isFeeCoin(value: unknown): value is FeeCoin {
  const coin = value as Partial<FeeCoin> | null;
  return typeof coin?.denom === "string" && typeof coin.amount === "string";
}

/* -------------------------------------------------------------------------- *
 * Amino
 * -------------------------------------------------------------------------- */

export function aminoFeeOf(signDoc: unknown): TxFee | null {
  const fee = (signDoc as { fee?: { amount?: unknown; gas?: unknown } } | null)?.fee;
  if (!fee || !Array.isArray(fee.amount) || !fee.amount.every(isFeeCoin)) return null;
  const gas = typeof fee.gas === "string" ? fee.gas : typeof fee.gas === "number" ? String(fee.gas) : "";
  return { amount: fee.amount.map((coin) => ({ denom: coin.denom, amount: coin.amount })), gas };
}

/** The sign doc with its fee replaced by `coin`; gas, payer and granter are kept. */
export function withAminoFee<T extends { fee?: unknown }>(signDoc: T, coin: FeeCoin): T {
  const fee = (signDoc.fee ?? {}) as Record<string, unknown>;
  return { ...signDoc, fee: { ...fee, amount: [{ denom: coin.denom, amount: coin.amount }] } };
}

/* -------------------------------------------------------------------------- *
 * Direct: `cosmos.tx.v1beta1.AuthInfo` holds `Fee` at field 2, which holds
 * its coins at field 1 and the gas limit at field 2.
 * -------------------------------------------------------------------------- */

const utf8 = new TextDecoder("utf-8", { fatal: true });

function coinFrom(bytes: Uint8Array | undefined): FeeCoin | null {
  if (!bytes) return null;
  let denom = "";
  let amount = "";
  for (const field of readProtoFields(bytes)) {
    if (field.field === 1 && field.bytes) denom = utf8.decode(field.bytes);
    else if (field.field === 2 && field.bytes) amount = utf8.decode(field.bytes);
  }
  return denom ? { denom, amount: amount || "0" } : null;
}

function feeField(authInfo: Uint8Array) {
  const fields = readProtoFields(authInfo);
  const fees = fields.filter((field) => field.field === 2);
  const fee = fees[0];
  if (fees.length !== 1 || !fee?.bytes) return null;
  return { fields, fee, feeFields: readProtoFields(fee.bytes) };
}

/** The fee inside `AuthInfo` bytes, or `null` when there is no single readable one. */
export function authInfoFee(authInfo: Uint8Array): TxFee | null {
  try {
    const found = feeField(authInfo);
    if (!found) return null;
    const amount: FeeCoin[] = [];
    let gas = 0n;
    for (const field of found.feeFields) {
      if (field.field === 1) {
        const coin = coinFrom(field.bytes);
        if (!coin) return null;
        amount.push(coin);
      } else if (field.field === 2) {
        if (field.varint === undefined) return null;
        gas = field.varint;
      }
    }
    return { amount, gas: gas.toString() };
  } catch {
    return null;
  }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * `AuthInfo` bytes with the fee coins replaced by `coin`. Every other field,
 * signer infos, gas limit, payer, granter and tip, is kept byte for byte.
 */
export function withAuthInfoFee(authInfo: Uint8Array, coin: FeeCoin): Uint8Array {
  const found = feeField(authInfo);
  if (!found) throw new Error("The transaction has no single fee to change");
  const coinBytes = new ProtoWriter().string(1, coin.denom).string(2, coin.amount).intoBytes();
  const fee = concat([
    lengthDelimitedField(1, coinBytes),
    ...found.feeFields.filter((field) => field.field !== 1).map((field) => field.raw),
  ]);
  return concat(
    found.fields.map((field) => (field === found.fee ? lengthDelimitedField(2, fee) : field.raw)),
  );
}
