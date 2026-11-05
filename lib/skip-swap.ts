/**
 * A swap in one signature from the chain that holds the funds: an IBC
 * transfer to Osmosis whose memo hands the tokens to Skip Go's entry point,
 * which swaps them in Osmosis's pools and pays the result out, on Osmosis or
 * over a channel to the To's chain (config/interchain.ts `SKIP_ENTRY_POINT`).
 *
 * The memo is ibc-hooks' `{"wasm":{"contract","msg"}}` with Skip's
 * `swap_and_action`: the pools and denoms of the Osmosis router's route, the
 * least the swap may pay, a deadline, and what to do with the output. Nothing
 * on Osmosis needs the user's signature or OSMO for gas: the relayer that
 * delivers the packet pays.
 *
 * What happens when it goes wrong:
 * - the swap fails on Osmosis (the price moved past the minimum, or the
 *   deadline passed): ibc-hooks answers the packet with an error and the
 *   holding chain gives the tokens back to the sender;
 * - the delivery after the swap fails (a timeout or a refusal on the To's
 *   chain): Skip's IBC adapter pays the output to `recover_address`, the
 *   user's own address on Osmosis.
 *
 * Pure apart from {@link verifySkipEntryPoint}: the memo is built and read
 * back here, and the screen refuses to sign a transaction this module does not
 * read back exactly as it was reviewed.
 */

import { buildPlanTransferMsg, isInterchainError, type BuiltMsg, type RoutePlan } from "@zunialab/interchain";

import {
  PACKET_TIMEOUT_MINUTES,
  SKIP_ENTRY_POINT,
  SKIP_SWAP_TIMEOUT_MINUTES,
  SKIP_SWAP_VENUE,
  SWAP_VENUE_CHAIN_ID,
} from "../config/interchain";
import { chainRegistry, lcdFor } from "./interchain";
import { readDeliveryTransfer, sameRoutes, type DeliveryTransferFacts, type PoolRoute } from "./pool-swap";

const POSITIVE = /^[1-9]\d*$/;
const DIGITS = /^\d+$/;
/** The Cosmos SDK's own denom rule. */
const DENOM = /^[a-zA-Z][a-zA-Z0-9/:._-]{2,127}$/;
const CHANNEL = /^channel-\d+$/;
/** Stands for the deadline while the memo is serialized; replaced by the bare number. */
const TIMEOUT_MARK = "__zunia_skip_timeout_ns__";

/* -------------------------------------------------------------------------- *
 * The memo
 * -------------------------------------------------------------------------- */

/** Where Skip's entry point pays the swap's output. */
export type SkipDelivery =
  /** On Osmosis, to `toAddress`: a bank send. */
  | { readonly kind: "osmosis"; readonly toAddress: string }
  /**
   * Over `sourceChannel` from Osmosis to `receiver`; if that transfer fails
   * the output is paid to `recoverAddress` on Osmosis.
   */
  | {
      readonly kind: "ibc";
      readonly sourceChannel: string;
      readonly receiver: string;
      readonly recoverAddress: string;
    };

/** What the memo of a one-signature swap says. */
export interface SkipSwapArgs {
  /** The Osmosis router's order: pools in sequence, and each route's share of the input. */
  readonly routes: readonly PoolRoute[];
  /** The input as it arrives on Osmosis. */
  readonly venueInputDenom: string;
  /** What the swap buys, as Osmosis names it. */
  readonly venueOutputDenom: string;
  /** Below this the entry point refuses the swap. */
  readonly minOut: string;
  readonly delivery: SkipDelivery;
  /** Unix time in nanoseconds after which the entry point refuses the swap. */
  readonly timeoutNs: bigint;
}

/** Skip's swap operations for one route: each pool, what it takes and what it pays. */
function operationsOf(route: PoolRoute, venueInputDenom: string) {
  let denomIn = venueInputDenom;
  return route.hops.map((hop) => {
    const operation = { pool: hop.poolId, denom_in: denomIn, denom_out: hop.tokenOutDenom };
    denomIn = hop.tokenOutDenom;
    return operation;
  });
}

/** Why `args` cannot become a memo, or `null` when it can. */
function argsProblem(args: SkipSwapArgs): string | null {
  if (!DENOM.test(args.venueInputDenom) || !DENOM.test(args.venueOutputDenom)) return "a denom is not a denom";
  if (args.venueInputDenom === args.venueOutputDenom) return "both sides are the same token";
  if (args.routes.length === 0) return "there is no route";
  for (const route of args.routes) {
    if (route.hops.length === 0) return "a route has no pool";
    if (!route.hops.every((hop) => POSITIVE.test(hop.poolId) && DENOM.test(hop.tokenOutDenom))) {
      return "a route names something that is not a pool";
    }
    if (route.hops[route.hops.length - 1]?.tokenOutDenom !== args.venueOutputDenom) {
      return "a route ends in another token";
    }
    if (args.routes.length > 1 && !POSITIVE.test(route.inAmount)) return "a route takes no input";
  }
  if (!POSITIVE.test(args.minOut)) return "there is no minimum output";
  if (args.timeoutNs <= 0n) return "there is no deadline";
  if (args.delivery.kind === "osmosis") {
    if (!args.delivery.toAddress.startsWith("osmo1")) return "the swap would pay an address that is not on Osmosis";
  } else {
    if (!CHANNEL.test(args.delivery.sourceChannel)) return "the delivery channel is not a channel";
    if (args.delivery.receiver.trim() === "") return "the delivery has no receiver";
    if (!args.delivery.recoverAddress.startsWith("osmo1")) return "the recovery address is not on Osmosis";
  }
  return null;
}

/**
 * The ibc-hooks memo that has Skip's entry point swap what arrives and pay it
 * out. One route is `swap_exact_asset_in`; a split order is
 * `smart_swap_exact_asset_in`, each route offering its share. The deadline is
 * a bare JSON number, as the contract's `u64` requires: 19 digits, written out
 * as text so no float rounds it. No affiliates: the Zunia fee is its own bank
 * send on the holding chain (lib/swap-fee.ts).
 */
export function buildSkipSwapMemo(args: SkipSwapArgs): string {
  const problem = argsProblem(args);
  if (problem) throw new Error(`Zunia will not build this swap: ${problem}.`);
  const userSwap =
    args.routes.length === 1 && args.routes[0]
      ? {
          swap_exact_asset_in: {
            swap_venue_name: SKIP_SWAP_VENUE,
            operations: operationsOf(args.routes[0], args.venueInputDenom),
          },
        }
      : {
          smart_swap_exact_asset_in: {
            swap_venue_name: SKIP_SWAP_VENUE,
            routes: args.routes.map((route) => ({
              offer_asset: { native: { denom: args.venueInputDenom, amount: route.inAmount } },
              operations: operationsOf(route, args.venueInputDenom),
            })),
          },
        };
  const postSwapAction =
    args.delivery.kind === "osmosis"
      ? { transfer: { to_address: args.delivery.toAddress } }
      : {
          ibc_transfer: {
            ibc_info: {
              source_channel: args.delivery.sourceChannel,
              receiver: args.delivery.receiver,
              memo: "",
              recover_address: args.delivery.recoverAddress,
            },
          },
        };
  const memo = JSON.stringify({
    wasm: {
      contract: SKIP_ENTRY_POINT.address,
      msg: {
        swap_and_action: {
          user_swap: userSwap,
          min_asset: { native: { denom: args.venueOutputDenom, amount: args.minOut } },
          timeout_timestamp: TIMEOUT_MARK,
          post_swap_action: postSwapAction,
          affiliates: [],
        },
      },
    },
  });
  return memo.replace(`"${TIMEOUT_MARK}"`, args.timeoutNs.toString());
}

/** The entry point's deadline for a swap signed at `nowMs`. */
export function skipSwapTimeoutNs(nowMs: number): bigint {
  return (BigInt(Math.floor(nowMs)) + BigInt(SKIP_SWAP_TIMEOUT_MINUTES) * 60_000n) * 1_000_000n;
}

/** A one-signature swap's memo, read back. */
export interface SkipSwapFacts {
  readonly contract: string;
  /** The input as the first pool takes it. */
  readonly venueInputDenom: string;
  /**
   * The routes. A single `swap_exact_asset_in` route swaps whatever arrives,
   * so its `inAmount` is `""` here; the caller fills in the transfer's amount.
   */
  readonly routes: readonly PoolRoute[];
  readonly outputDenom: string;
  readonly minOut: string;
  readonly timeoutNs: bigint;
  readonly delivery: SkipDelivery;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Exactly these keys, no more and no fewer. */
function keysAre(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function readNative(value: unknown): { denom: string; amount: string } | null {
  if (!isRecord(value) || !keysAre(value, ["native"])) return null;
  const coin = value.native;
  if (!isRecord(coin) || !keysAre(coin, ["denom", "amount"])) return null;
  const { denom, amount } = coin;
  if (typeof denom !== "string" || !DENOM.test(denom) || typeof amount !== "string" || !POSITIVE.test(amount)) {
    return null;
  }
  return { denom, amount };
}

/** One route's operations as pools, checked to chain from `denomIn`; `null` when they do not. */
function readOperations(raw: unknown, denomIn: string): PoolRoute["hops"] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const hops: { poolId: string; tokenOutDenom: string }[] = [];
  let expected = denomIn;
  for (const operation of raw) {
    if (!isRecord(operation) || !keysAre(operation, ["pool", "denom_in", "denom_out"])) return null;
    const { pool, denom_in: inDenom, denom_out: outDenom } = operation;
    if (typeof pool !== "string" || !POSITIVE.test(pool)) return null;
    if (inDenom !== expected || typeof outDenom !== "string" || !DENOM.test(outDenom)) return null;
    hops.push({ poolId: pool, tokenOutDenom: outDenom });
    expected = outDenom;
  }
  return hops;
}

function readDelivery(raw: unknown): SkipDelivery | null {
  if (!isRecord(raw)) return null;
  if (keysAre(raw, ["transfer"])) {
    const transfer = raw.transfer;
    if (!isRecord(transfer) || !keysAre(transfer, ["to_address"]) || typeof transfer.to_address !== "string") {
      return null;
    }
    return { kind: "osmosis", toAddress: transfer.to_address };
  }
  if (keysAre(raw, ["ibc_transfer"])) {
    const action = raw.ibc_transfer;
    if (!isRecord(action) || !keysAre(action, ["ibc_info"])) return null;
    const info = action.ibc_info;
    if (!isRecord(info) || !keysAre(info, ["source_channel", "receiver", "memo", "recover_address"])) return null;
    const { source_channel: channel, receiver, memo, recover_address: recover } = info;
    if (typeof channel !== "string" || typeof receiver !== "string" || typeof recover !== "string") return null;
    if (memo !== "") return null;
    return { kind: "ibc", sourceChannel: channel, receiver, recoverAddress: recover };
  }
  return null;
}

/**
 * Read a one-signature swap's memo, every key accounted for; `null` for
 * anything else, including a memo with affiliates, a `sent_asset`, a fee or a
 * forward memo after the delivery, which a review never shows. The deadline is
 * read from the text so its 19 digits survive.
 */
export function readSkipSwapMemo(memo: string): SkipSwapFacts | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(memo);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !keysAre(parsed, ["wasm"])) return null;
  const wasm = parsed.wasm;
  if (!isRecord(wasm) || !keysAre(wasm, ["contract", "msg"]) || typeof wasm.contract !== "string") return null;
  const msg = wasm.msg;
  if (!isRecord(msg) || !keysAre(msg, ["swap_and_action"])) return null;
  const call = msg.swap_and_action;
  if (
    !isRecord(call) ||
    !keysAre(call, ["user_swap", "min_asset", "timeout_timestamp", "post_swap_action", "affiliates"])
  ) {
    return null;
  }
  if (!Array.isArray(call.affiliates) || call.affiliates.length !== 0) return null;
  if (typeof call.timeout_timestamp !== "number") return null;
  const deadlines = [...memo.matchAll(/"timeout_timestamp":(\d+)[,}]/g)];
  const deadline = deadlines.length === 1 ? deadlines[0]?.[1] : undefined;
  if (!deadline || !DIGITS.test(deadline)) return null;

  const min = readNative(call.min_asset);
  if (!min) return null;
  const delivery = readDelivery(call.post_swap_action);
  if (!delivery) return null;

  const swap = call.user_swap;
  if (!isRecord(swap)) return null;
  let venueInputDenom: string;
  let routes: PoolRoute[];
  if (keysAre(swap, ["swap_exact_asset_in"])) {
    const exact = swap.swap_exact_asset_in;
    if (!isRecord(exact) || !keysAre(exact, ["swap_venue_name", "operations"])) return null;
    if (exact.swap_venue_name !== SKIP_SWAP_VENUE || !Array.isArray(exact.operations)) return null;
    const first = exact.operations[0];
    if (!isRecord(first) || typeof first.denom_in !== "string" || !DENOM.test(first.denom_in)) return null;
    venueInputDenom = first.denom_in;
    const hops = readOperations(exact.operations, venueInputDenom);
    if (!hops) return null;
    routes = [{ hops, inAmount: "" }];
  } else if (keysAre(swap, ["smart_swap_exact_asset_in"])) {
    const smart = swap.smart_swap_exact_asset_in;
    if (!isRecord(smart) || !keysAre(smart, ["swap_venue_name", "routes"])) return null;
    if (smart.swap_venue_name !== SKIP_SWAP_VENUE || !Array.isArray(smart.routes) || smart.routes.length === 0) {
      return null;
    }
    routes = [];
    let denomIn: string | null = null;
    for (const raw of smart.routes) {
      if (!isRecord(raw) || !keysAre(raw, ["offer_asset", "operations"])) return null;
      const offer = readNative(raw.offer_asset);
      if (!offer || (denomIn !== null && offer.denom !== denomIn)) return null;
      denomIn = offer.denom;
      const hops = readOperations(raw.operations, offer.denom);
      if (!hops) return null;
      routes.push({ hops, inAmount: offer.amount });
    }
    if (denomIn === null) return null;
    venueInputDenom = denomIn;
  } else {
    return null;
  }
  const outputs = new Set(routes.map((route) => route.hops[route.hops.length - 1]?.tokenOutDenom));
  if (outputs.size !== 1 || !outputs.has(min.denom)) return null;

  return {
    contract: wasm.contract,
    venueInputDenom,
    routes,
    outputDenom: min.denom,
    minOut: min.amount,
    timeoutNs: BigInt(deadline),
    delivery,
  };
}

/* -------------------------------------------------------------------------- *
 * The transfer
 * -------------------------------------------------------------------------- */

/**
 * The transfer the user signs: the amount left after the Zunia fee, over the
 * checked channel to Osmosis, to the entry point (ibc-hooks only runs a memo
 * whose receiver is the contract), with the swap's memo.
 */
export function buildRelayTransferMsg(args: {
  /** The checked hop from the holding chain to Osmosis (lib/pool-swap.ts `planPoolInbound`). */
  readonly inbound: RoutePlan;
  readonly sender: string;
  /** Base units the swap sells: `fee.net`. */
  readonly amountBaseUnits: string;
  readonly memo: string;
}): BuiltMsg {
  return buildPlanTransferMsg({
    plan: { ...args.inbound, memo: args.memo },
    receiver: SKIP_ENTRY_POINT.address,
    sender: args.sender,
    amount: args.amountBaseUnits,
    timeoutMinutes: PACKET_TIMEOUT_MINUTES,
  });
}

/** What a one-signature swap's review promised, for its transfer to be checked against. */
export interface RelayExpectation {
  /** The holding chain: the transaction signs there. */
  readonly chainId: string;
  /** The From's exact bank denom. */
  readonly denom: string;
  /** Base units sold: the amount less the Zunia fee. */
  readonly net: string;
  /** The checked hop to Osmosis. */
  readonly inbound: RoutePlan;
  readonly venueInputDenom: string;
  readonly venueOutputDenom: string;
  readonly routes: readonly PoolRoute[];
  readonly minOut: string;
  readonly delivery: SkipDelivery;
}

/** The transfer and its memo, read back; `null` when either cannot be read. */
export interface RelayFacts {
  readonly transfer: DeliveryTransferFacts;
  readonly swap: SkipSwapFacts;
}

/**
 * Read a one-signature swap's transfer and memo. A single route's input is
 * the transfer's amount, filled in here, so the routes compare whole.
 */
export function readRelayMsg(msg: BuiltMsg | undefined): RelayFacts | null {
  const transfer = readDeliveryTransfer(msg);
  if (!transfer) return null;
  const swap = readSkipSwapMemo(transfer.memo);
  if (!swap) return null;
  const routes =
    swap.routes.length === 1 && swap.routes[0]?.inAmount === ""
      ? [{ ...swap.routes[0], inAmount: transfer.token.amount }]
      : swap.routes;
  return { transfer, swap: { ...swap, routes } };
}

function sameDelivery(a: SkipDelivery, b: SkipDelivery): boolean {
  if (a.kind === "osmosis" || b.kind === "osmosis") {
    return a.kind === b.kind && a.kind === "osmosis" && b.kind === "osmosis" && a.toAddress === b.toAddress;
  }
  return a.sourceChannel === b.sourceChannel && a.receiver === b.receiver && a.recoverAddress === b.recoverAddress;
}

/**
 * Everything a one-signature swap's transfer does that its review did not
 * say; empty when it is exactly the reviewed transfer and memo. The fee
 * message and anything after it are checked by the caller.
 */
export function relayMessageProblems(
  facts: RelayFacts | null,
  expected: RelayExpectation,
  signing: { readonly chainId: string; readonly signerAddress: string; readonly now: number },
): string[] {
  if (!facts) return ["Zunia could not read this swap's transfer and memo back, so it will not sign it."];
  const { transfer, swap } = facts;
  const problems: string[] = [];
  const hop = expected.inbound.hops[0];
  if (signing.chainId !== expected.chainId) {
    problems.push(`This swap signs on ${expected.chainId}, the chain holding the tokens, not on ${signing.chainId}.`);
  }
  if (transfer.sender !== signing.signerAddress) problems.push("The transfer would leave another account than the one signing.");
  if (transfer.token.denom !== expected.denom) problems.push("The transfer sends another token than the one you sell.");
  else if (transfer.token.amount !== expected.net) problems.push("The transfer sends another amount than the one reviewed.");
  if (!hop || transfer.sourceChannel !== hop.channelId || transfer.sourcePort !== (hop.port || "transfer")) {
    problems.push("The transfer leaves over another channel than the one Zunia checked.");
  }
  if (transfer.receiver !== SKIP_ENTRY_POINT.address || swap.contract !== SKIP_ENTRY_POINT.address) {
    problems.push("The transfer goes to another contract than Skip's verified entry point.");
  }
  const nowNs = BigInt(Math.floor(signing.now)) * 1_000_000n;
  if (BigInt(transfer.timeoutTimestamp) <= nowNs) problems.push("The transfer's timeout has already passed. Refresh the price.");
  if (swap.timeoutNs <= nowNs) problems.push("The swap's deadline has already passed. Refresh the price.");
  if (swap.venueInputDenom !== expected.venueInputDenom) {
    problems.push("The swap would sell another token on Osmosis than the one the transfer delivers.");
  }
  if (swap.outputDenom !== expected.venueOutputDenom) problems.push("The swap would buy another token than the one you picked.");
  if (swap.minOut !== expected.minOut) problems.push("The swap's minimum is not the one you reviewed.");
  if (!sameRoutes(swap.routes, expected.routes)) {
    problems.push("The swap would go through other pools, or other amounts, than the route you reviewed.");
  }
  if (!sameDelivery(swap.delivery, expected.delivery)) {
    problems.push("The swap would pay its output to another address or over another channel than the one reviewed.");
  }
  return problems;
}

/* -------------------------------------------------------------------------- *
 * The contract, checked on chain
 * -------------------------------------------------------------------------- */

/** Whether Skip's entry point is the contract the configuration names. */
export interface SkipEntryPointCheck {
  readonly ok: boolean;
  /** Why the path stays off; `null` when it may be used. */
  readonly reason: string | null;
  readonly label: string | null;
}

let entryCache: { at: number; check: SkipEntryPointCheck } | null = null;
const ENTRY_CACHE_MS = 5 * 60_000;

/** The verdict on one contract-info answer: code id, label and the absence of an admin. */
export function judgeEntryPoint(body: unknown): SkipEntryPointCheck {
  const row = isRecord(body) ? body : null;
  const info = row && isRecord(row.contract_info) ? row.contract_info : null;
  if (!row || row.address !== SKIP_ENTRY_POINT.address || !info) {
    return { ok: false, label: null, reason: "Skip's entry point is not a contract on Osmosis, so one-signature swaps stay off." };
  }
  const label = typeof info.label === "string" ? info.label : null;
  const admin = typeof info.admin === "string" ? info.admin : "";
  if (String(info.code_id) !== SKIP_ENTRY_POINT.codeId || label !== SKIP_ENTRY_POINT.label) {
    return {
      ok: false,
      label,
      reason: "The contract at Skip's entry point address is not the code Zunia checked, so one-signature swaps stay off.",
    };
  }
  if (admin !== "") {
    return {
      ok: false,
      label,
      reason: "Skip's entry point now has an admin who could change it, so one-signature swaps stay off.",
    };
  }
  return { ok: true, label, reason: null };
}

/**
 * Read Skip's entry point on Osmosis and check it is the immutable contract
 * the configuration names. Never throws; cached for a few minutes.
 */
export async function verifySkipEntryPoint(options?: {
  signal?: AbortSignal;
  force?: boolean;
}): Promise<SkipEntryPointCheck> {
  if (!options?.force && entryCache && Date.now() - entryCache.at < ENTRY_CACHE_MS) return entryCache.check;
  const chain = chainRegistry().get(SWAP_VENUE_CHAIN_ID);
  if (!chain) {
    return { ok: false, label: null, reason: `${SWAP_VENUE_CHAIN_ID} is not in this wallet's chain list.` };
  }
  try {
    const body = await lcdFor(chain).getJson(
      `/cosmwasm/wasm/v1/contract/${encodeURIComponent(SKIP_ENTRY_POINT.address)}`,
      { cacheTtlMs: ENTRY_CACHE_MS, ...(options?.signal ? { signal: options.signal } : {}) },
    );
    const check = judgeEntryPoint(body);
    if (check.ok) entryCache = { at: Date.now(), check };
    return check;
  } catch (error) {
    if (isInterchainError(error) && (error.httpStatus === 404 || error.httpStatus === 400)) {
      return judgeEntryPoint(null);
    }
    return {
      ok: false,
      label: null,
      reason: "Could not reach Osmosis to check Skip's entry point, so one-signature swaps stay off for now.",
    };
  }
}

/** Forget the cached check (tests). */
export function resetSkipEntryPointCheck(): void {
  entryCache = null;
}
