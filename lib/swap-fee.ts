/**
 * Zunia's swap commission: what it comes to, the bank send that pays it, and
 * the check that a transaction pays exactly that and nothing else.
 *
 * The rate and the treasury addresses are compiled in (config/fees.ts). The
 * crosschain-swaps contract's `osmosis_swap` has no fee field, so the fee is a
 * `MsgSend` of its own, signed in the same transaction right after the swap
 * message, in the token sold. It comes out of the amount the user typed (or
 * Max): that amount is what they spend in all, and the swap itself sells what
 * is left ({@link SwapFee.net}).
 *
 * Pure: no network, no storage, no clock. Every function takes the treasury
 * map as an optional argument, so a test injects its own instead of editing
 * the shipped one.
 */

import { bech32 } from "@scure/base";
import type { BuiltMsg } from "@zunialab/interchain";

import { SWAP_FEE_BPS, SWAP_FEE_RECIPIENTS } from "../config/fees";
import { CHAIN_CATALOG } from "./chain-catalog";

/** Treasury address by chain id, the shape of config/fees.ts `SWAP_FEE_RECIPIENTS`. */
export type SwapFeeRecipients = Readonly<Record<string, string>>;

/** The proto type of the bank send that pays the fee. */
export const BANK_SEND_TYPE_URL = "/cosmos.bank.v1beta1.MsgSend";

/** Basis points in a whole. */
const BPS_PER_WHOLE = 10_000;

/** The Zunia fee on one swap. */
export interface SwapFee {
  /** The rate charged, in basis points of the amount: the configured rate, or 0 when no fee is taken. */
  readonly bps: number;
  /** Base units of the token sold paid to {@link recipient}; `0n` when no fee is taken. */
  readonly fee: bigint;
  /** Base units the swap itself sells: the amount less {@link fee}. */
  readonly net: bigint;
  /** The treasury on the signing chain; `null` exactly when no fee is taken. */
  readonly recipient: string | null;
}

/** A coin's bank send, as {@link readSwapFeeMsg} reads it out of a message. */
export interface SwapFeeMessage {
  /** `from_address`: the account the fee leaves. */
  readonly from: string;
  /** `to_address`: where the fee goes. */
  readonly to: string;
  /** The one coin's denom. */
  readonly denom: string;
  /** The one coin's amount: base units, digits only, above zero. */
  readonly amount: string;
}

/**
 * Why `address` cannot receive the fee on `chainId`, or `null` when it can: a
 * bech32 address (checksum included) in its canonical lowercase spelling, of
 * an account (20 bytes) or a contract (32 bytes), carrying the prefix the
 * bundled catalog gives that chain. Only the bundled catalog counts: a chain
 * the user added by hand states its own prefix, and the release does not take
 * that on its word.
 */
export function swapFeeRecipientProblem(chainId: string, address: string): string | null {
  const entry = CHAIN_CATALOG.find((row) => row.chainId === chainId);
  if (!entry) return `${chainId} is not a chain this release bundles.`;
  let decoded: { prefix: string; bytes: Uint8Array };
  try {
    decoded = bech32.decodeToBytes(address);
  } catch {
    return `${address} is not a valid bech32 address.`;
  }
  if (address !== address.toLowerCase()) return `${address} is not in lowercase.`;
  if (decoded.prefix !== entry.bech32Prefix) {
    return `${address} carries the prefix ${decoded.prefix}, not ${chainId}'s ${entry.bech32Prefix}.`;
  }
  if (decoded.bytes.length !== 20 && decoded.bytes.length !== 32) {
    return `${address} holds ${decoded.bytes.length} bytes, not an account's 20 or a contract's 32.`;
  }
  return null;
}

/**
 * The treasury configured for `chainId`, or `null` when there is none. An
 * entry that fails {@link swapFeeRecipientProblem} counts as none, so a bad
 * address can only ever mean no fee, never a fee sent somewhere else; the
 * release test refuses such a build before it gets this far.
 */
export function swapFeeRecipient(
  chainId: string,
  recipients: SwapFeeRecipients = SWAP_FEE_RECIPIENTS,
): string | null {
  if (!Object.hasOwn(recipients, chainId)) return null;
  const address = recipients[chainId];
  return typeof address === "string" && swapFeeRecipientProblem(chainId, address) === null ? address : null;
}

/**
 * The Zunia fee on `amountUnits` base units sold on `chainId`: `bps` basis
 * points of it, rounded down (`floor(amount × bps / 10000)`, so rounding only
 * ever favours the user), and what is left for the swap. No fee at all (`fee`
 * 0, `net` the whole amount, no recipient) when the chain has no treasury, the
 * amount is not above zero, the rate is not a whole number of basis points
 * below 100%, or the amount is too small to carry one base unit of fee.
 */
export function swapFeeFor(
  chainId: string,
  amountUnits: bigint,
  recipients: SwapFeeRecipients = SWAP_FEE_RECIPIENTS,
  bps: number = SWAP_FEE_BPS,
): SwapFee {
  const none: SwapFee = { bps: 0, fee: 0n, net: amountUnits, recipient: null };
  if (amountUnits <= 0n || !Number.isSafeInteger(bps) || bps <= 0 || bps >= BPS_PER_WHOLE) return none;
  const recipient = swapFeeRecipient(chainId, recipients);
  if (recipient === null) return none;
  const fee = (amountUnits * BigInt(bps)) / BigInt(BPS_PER_WHOLE);
  return fee > 0n ? { bps, fee, net: amountUnits - fee, recipient } : none;
}

/** Whether two fees are the same fee: rate, amount, remainder and recipient. */
export function sameSwapFee(a: SwapFee, b: SwapFee): boolean {
  return a.bps === b.bps && a.fee === b.fee && a.net === b.net && a.recipient === b.recipient;
}

/** A rate in basis points as a percentage, from whole numbers: 50 is `0.5%`, 25 is `0.25%`, 100 is `1%`. */
export function feeRateText(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const hundredths = String(bps % 100).padStart(2, "0").replace(/0$/, "");
  return bps % 100 === 0 ? `${whole}%` : `${whole}.${hundredths}%`;
}

/**
 * The bank send that pays the fee, in the shape the kernel signs a
 * `MsgSend` in (the proto-JSON of `/cosmos.bank.v1beta1.MsgSend`, as
 * lib/amino-tx.ts `msgSend` writes its value): from the signer, to the
 * treasury, one coin of the denom sold.
 *
 * @throws when a field is empty or the amount is not above zero: a fee message
 *   with nothing to pay is never built.
 */
export function buildSwapFeeMsg(args: {
  readonly sender: string;
  readonly recipient: string;
  readonly denom: string;
  readonly amount: bigint;
}): BuiltMsg {
  if (!args.sender || !args.recipient || !args.denom || args.amount <= 0n) {
    throw new Error("A swap fee needs a sender, a recipient, a denom and an amount above zero.");
  }
  return {
    typeUrl: BANK_SEND_TYPE_URL,
    value: {
      from_address: args.sender,
      to_address: args.recipient,
      amount: [{ denom: args.denom, amount: args.amount.toString() }],
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Exactly these keys, in any order, and no other. */
function hasExactly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/**
 * What a message pays, read as a plain bank send of one coin: `null` for any
 * other message, and for a bank send carrying anything this does not show (a
 * second coin, a field `MsgSend` does not have, an amount that is not a
 * positive integer). What cannot be read whole is never called a fee.
 */
export function readSwapFeeMsg(msg: BuiltMsg | undefined): SwapFeeMessage | null {
  if (!msg || msg.typeUrl !== BANK_SEND_TYPE_URL || !isRecord(msg.value)) return null;
  const value: Record<string, unknown> = msg.value;
  if (!hasExactly(value, ["from_address", "to_address", "amount"])) return null;
  const { from_address: from, to_address: to, amount: coins } = value;
  if (typeof from !== "string" || from === "" || typeof to !== "string" || to === "") return null;
  if (!Array.isArray(coins) || coins.length !== 1) return null;
  const coin: unknown = coins[0];
  if (!isRecord(coin) || !hasExactly(coin, ["denom", "amount"])) return null;
  const { denom, amount } = coin;
  if (typeof denom !== "string" || denom === "") return null;
  if (typeof amount !== "string" || !/^[1-9]\d*$/.test(amount)) return null;
  return { from, to, denom, amount };
}

/** What a swap transaction must pay as its Zunia fee. */
export interface SwapFeeExpectation {
  /** The chain that signs the swap: the treasury is the one configured for it. */
  readonly chainId: string;
  /** The account signing the swap: the fee leaves it. */
  readonly signer: string;
  /** The exact bank denom sold: the fee is paid in it. */
  readonly denom: string;
  /** Base units spent in all, the fee included: what the fee is a share of. */
  readonly amountUnits: bigint;
  /** The treasury map; the compiled-in one unless a test passes its own. */
  readonly recipients?: SwapFeeRecipients;
}

/** One way a transaction's fee message is not the fee the swap owes. */
export type SwapFeeIssue =
  /** A second message that is not a plain bank send of one coin. */
  | { readonly kind: "unreadable" }
  /** A fee paid when none is owed: no treasury on the chain, or an amount too small to carry one. */
  | { readonly kind: "not-due"; readonly paid: SwapFeeMessage }
  /** No fee message, when a fee is owed. */
  | { readonly kind: "missing"; readonly due: SwapFee }
  /** Paid from another account than the signer's. */
  | { readonly kind: "sender"; readonly paid: SwapFeeMessage }
  /** Paid to another address than the chain's treasury. */
  | { readonly kind: "recipient"; readonly paid: SwapFeeMessage; readonly due: SwapFee }
  /** Paid in another denom than the one sold. */
  | { readonly kind: "denom"; readonly paid: SwapFeeMessage }
  /** Paid in the denom sold, but another amount than the fee owed. */
  | { readonly kind: "amount"; readonly paid: SwapFeeMessage; readonly due: SwapFee };

/**
 * Every way `msg`, the message a swap transaction signs after the swap
 * (`undefined` when it signs none), differs from the Zunia fee the swap owes;
 * empty when it is exactly that fee.
 *
 * The fee owed is worked out again here from the configuration
 * ({@link swapFeeFor}), never taken from the caller. When one is owed the
 * message must be one bank send from the signer to the chain's treasury, of
 * one coin, the denom sold, for exactly that amount. When none is owed there
 * must be no message at all.
 */
export function swapFeeIssues(msg: BuiltMsg | undefined, expected: SwapFeeExpectation): SwapFeeIssue[] {
  const due = swapFeeFor(expected.chainId, expected.amountUnits, expected.recipients);
  if (msg === undefined) return due.fee > 0n ? [{ kind: "missing", due }] : [];
  const paid = readSwapFeeMsg(msg);
  if (!paid) return [{ kind: "unreadable" }];
  if (due.fee === 0n || due.recipient === null) return [{ kind: "not-due", paid }];
  const issues: SwapFeeIssue[] = [];
  if (paid.from !== expected.signer) issues.push({ kind: "sender", paid });
  if (paid.to !== due.recipient) issues.push({ kind: "recipient", paid, due });
  if (paid.denom !== expected.denom) issues.push({ kind: "denom", paid });
  else if (paid.amount !== due.fee.toString()) issues.push({ kind: "amount", paid, due });
  return issues;
}
