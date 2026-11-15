/**
 * Gas and fee for wallet-originated amino transactions, worked out the way a
 * node checks them.
 *
 * A node refuses a transaction at broadcast ("insufficient fee") when
 * `fee < ceil(gasLimit x minimum-gas-price)`, and burns the fee when the gas
 * runs out in the block. So the gas limit comes from a simulation of the very
 * bytes that will be signed, and the fee from exact integer arithmetic against
 * the larger of the wallet's price and the node's own minimum. Floats are not
 * used on base units: 18-decimal chains (Injective: 1.6e8 to 1.5e9 inj per gas)
 * pass 2^53 within a few million gas.
 */

import { assembleAminoTxRaw, makeStdSignDoc, type AminoMsg, type Coin, type StdFee } from "./amino-tx";
import { toBase64 } from "./kernel";

/** An exact non-negative rational, for gas prices. */
export interface Ratio {
  readonly num: bigint;
  readonly den: bigint;
}

/** Parse `0.025`, `1500000000`, `1e-7` or a JS number into an exact ratio. */
export function toRatio(value: string | number): Ratio {
  const text = typeof value === "number" ? numberToPlain(value) : value.trim();
  const match = /^(\d+)?(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match || (match[1] === undefined && match[2] === undefined)) {
    throw new Error(`${String(value)} is not a gas price`);
  }
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  const shift = Number(match[3] ?? "0") - fraction.length;
  const digits = BigInt(`${whole}${fraction}`);
  return shift >= 0
    ? { num: digits * 10n ** BigInt(shift), den: 1n }
    : { num: digits, den: 10n ** BigInt(-shift) };
}

function numberToPlain(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${value} is not a gas price`);
  return value.toString();
}

export function ceilDiv(num: bigint, den: bigint): bigint {
  return (num + den - 1n) / den;
}

/** `ceil(gas x price)`, never below 1 for a non-zero price. */
export function feeAmountFor(gas: bigint, price: Ratio): bigint {
  return ceilDiv(gas * price.num, price.den);
}

export function maxRatio(a: Ratio, b: Ratio): Ratio {
  return a.num * b.den >= b.num * a.den ? a : b;
}

/** The price a given fee implies for a given gas limit; `null` for gas 0. */
export function impliedPrice(feeAmount: bigint, gas: bigint): Ratio | null {
  return gas > 0n ? { num: feeAmount, den: gas } : null;
}

/**
 * A node's `minimum_gas_price` string: `"0.025uatom,0.01uosmo"` (an SDK
 * DecCoins list; some builds separate with `;`). Entries that do not parse
 * are skipped, never guessed.
 */
export function parseMinGasPrices(raw: unknown): Array<{ denom: string; price: Ratio }> {
  if (typeof raw !== "string") return [];
  const out: Array<{ denom: string; price: Ratio }> = [];
  for (const part of raw.split(/[,;]/)) {
    const match = /^\s*(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*([A-Za-z][A-Za-z0-9/:._-]{2,127})\s*$/.exec(part);
    if (!match) continue;
    out.push({ denom: match[2]!, price: toRatio(match[1]!) });
  }
  return out;
}

export type JsonGet = (path: string) => Promise<unknown>;

/** The node's minimum price in `denom`, or `null` when it publishes none. */
export async function fetchMinGasPrice(get: JsonGet, denom: string): Promise<Ratio | null> {
  try {
    const body = (await get("/cosmos/base/node/v1beta1/config")) as { minimum_gas_price?: unknown } | null;
    const row = parseMinGasPrices(body?.minimum_gas_price).find((p) => p.denom === denom);
    return row?.price ?? null;
  } catch {
    return null;
  }
}

export interface FeePlanInput {
  /** What the screen showed: its gas limit and fee. The plan never lowers the price below it. */
  readonly callerGas: bigint;
  readonly callerFee: readonly Coin[];
  /** Fee denom when the caller gave no fee. */
  readonly feeDenom: string;
  /** The wallet's price for the chosen speed. */
  readonly walletPrice: Ratio | null;
  readonly nodeMinPrice: Ratio | null;
  /** Gas a simulation of the real message list used; `null` when none ran. */
  readonly simulatedGas: bigint | null;
  readonly gasAdjustment: number;
}

export interface FeePlan {
  readonly fee: StdFee;
  readonly gas: bigint;
  readonly gasSource: "simulated" | "fallback";
}

/**
 * Gas limit and fee to sign. Simulated gas times the user's adjustment when a
 * simulation ran, else the screen's fixed limit. Price: the highest of the
 * price the screen quoted, the wallet's table and the node's minimum, so a
 * chain that raised its floor cannot refuse the claim as "insufficient fee".
 */
export function planFee(input: FeePlanInput): FeePlan {
  const denom = input.callerFee[0]?.denom ?? input.feeDenom;
  let gas = input.callerGas;
  let gasSource: FeePlan["gasSource"] = "fallback";
  if (input.simulatedGas !== null && input.simulatedGas > 0n) {
    const adj = toRatio(Math.max(1, input.gasAdjustment));
    gas = ceilDiv(input.simulatedGas * adj.num, adj.den);
    gasSource = "simulated";
  }
  if (gas < 1n) gas = 1n;

  let price: Ratio = input.walletPrice ?? { num: 0n, den: 1n };
  const callerAmount = input.callerFee.find((c) => c.denom === denom)?.amount;
  if (callerAmount && /^\d+$/.test(callerAmount)) {
    const quoted = impliedPrice(BigInt(callerAmount), input.callerGas);
    if (quoted) price = maxRatio(price, quoted);
  }
  if (input.nodeMinPrice) price = maxRatio(price, input.nodeMinPrice);

  const amount = feeAmountFor(gas, price);
  return {
    gas,
    gasSource,
    fee: {
      amount: amount === 0n ? [] : [{ denom, amount: amount.toString() }],
      gas: gas.toString(),
    },
  };
}

/** The fee a node asked for in an "insufficient fee" refusal: `required: 2500uatom`. */
export function requiredFeeOf(error: unknown): { denom: string; amount: bigint } | null {
  const text = error instanceof Error ? `${error.message} ${(error as { rawLog?: string }).rawLog ?? ""}` : String(error);
  const match = /required:?\s*(\d+)\s*([A-Za-z][A-Za-z0-9/:._-]{1,126}[A-Za-z0-9])/i.exec(text);
  return match ? { denom: match[2]!, amount: BigInt(match[1]!) } : null;
}

export function isInsufficientFee(error: unknown): boolean {
  const code = (error as { code?: number } | null)?.code;
  if (code === 13) return true;
  const text = error instanceof Error ? `${error.message} ${(error as { rawLog?: string }).rawLog ?? ""}` : String(error);
  return /insufficient fee|insufficient minimum gas|fee not provided|provided fee < minimum/i.test(text);
}

/** The amino message list as the exact tx a simulation POSTs: zero signature, real sequence. */
export function buildSimulateBytes(params: {
  chainId: string;
  accountNumber: string;
  sequence: string;
  msgs: AminoMsg[];
  memo: string;
  gasLimit: bigint;
  pubKey: Uint8Array;
  ethKeyType?: boolean;
  ethPubKeyTypeUrl?: string;
}): Uint8Array {
  const signDoc = makeStdSignDoc({
    chainId: params.chainId,
    accountNumber: params.accountNumber,
    sequence: params.sequence,
    fee: { amount: [], gas: params.gasLimit.toString() },
    msgs: params.msgs,
    memo: params.memo,
  });
  return assembleAminoTxRaw({
    signDoc,
    pubKey: params.pubKey,
    signature: new Uint8Array(64),
    ethKeyType: params.ethKeyType,
    ethPubKeyTypeUrl: params.ethPubKeyTypeUrl,
  });
}

export class SimulationRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimulationRejected";
  }
}

export type JsonPost = (path: string, body: unknown) => Promise<{ status: number; body: unknown }>;

/**
 * Simulate. Returns gas used, or `null` when the node cannot simulate (route
 * disabled, timeout, a stale sequence): the caller then keeps its fixed limit.
 * Throws {@link SimulationRejected} when the node ran the messages and they
 * failed (no delegation, validator gone): signing that would only burn a fee.
 */
export async function simulateGas(post: JsonPost, txBytes: Uint8Array): Promise<bigint | null> {
  let res: { status: number; body: unknown };
  try {
    res = await post("/cosmos/tx/v1beta1/simulate", { tx_bytes: toBase64(txBytes) });
  } catch {
    return null;
  }
  const body = (res.body ?? {}) as { gas_info?: { gas_used?: unknown }; message?: unknown };
  if (res.status >= 200 && res.status < 300) {
    const used = body.gas_info?.gas_used;
    return typeof used === "string" && /^\d+$/.test(used) ? BigInt(used) : null;
  }
  const message = typeof body.message === "string" ? body.message : "";
  if (/failed to execute message/i.test(message)) {
    throw new SimulationRejected(message);
  }
  return null;
}
