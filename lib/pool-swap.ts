/**
 * Swaps on Osmosis's own pools, with no contract in between.
 *
 * The crosschain-swaps contract (lib/xcs-routes.ts) executes only the pairs in
 * its swaprouter's table: 39 directional routes on 2026-10-05, none of them
 * OSMO to USDC.inj. Osmosis's poolmanager module swaps any pair its pools
 * connect, along any route, and the Osmosis router (SQS) finds the best one,
 * split across several routes when that pays more. So when the funds are
 * already on Osmosis, Zunia signs poolmanager's own message for the router's
 * route:
 *
 * - `MsgSwapExactAmountIn` for one route;
 * - `MsgSplitRouteSwapExactAmountIn` when the router splits the order.
 *
 * Both carry `token_out_min_amount`. The chain refuses the whole transaction
 * when the swap would pay less, so the floor is a number in the signed message
 * (the quote's output less the slippage tolerance), not a rule like the
 * contract's TWAP tolerance. The message therefore depends on the price: a new
 * price is a new message, built and previewed again.
 *
 * poolmanager pays the output to the signer. A token wanted on another chain
 * is sent on in the same transaction: an ICS20 transfer of exactly the floor,
 * over the channel the planner checked ({@link planPoolDelivery}). The swap
 * pays at least the floor, so the transfer always has it to send; whatever the
 * swap pays above it stays in the signer's Osmosis account. If the swap pays
 * less, the chain refuses everything, the fee and the transfer included.
 *
 * Signing these messages needs a kernel that knows them (zunia-core's
 * poolmanager variants). Nothing here signs.
 */

import {
  applySlippage,
  isInterchainError,
  quoteOsmosisSwap,
  type BuiltMsg,
  type OsmosisSwapQuote,
} from "@zunialab/interchain";

import { SWAP_VENUE_CHAIN_ID } from "../config/interchain";
import { chainRegistry, describeInterchainError, lcdFor, swapRouterClient } from "./interchain";
import { planTransfer, type ManualChannel, type RoutePlanView } from "./route-plan";

const VENUE = SWAP_VENUE_CHAIN_ID;

export const POOL_SWAP_TYPE_URL = "/osmosis.poolmanager.v1beta1.MsgSwapExactAmountIn";
export const POOL_SPLIT_SWAP_TYPE_URL = "/osmosis.poolmanager.v1beta1.MsgSplitRouteSwapExactAmountIn";
export const TRANSFER_TYPE_URL = "/ibc.applications.transfer.v1.MsgTransfer";

/**
 * Pools one route may pass through. The router's longest routes are three or
 * four pools; a route this long is not one it returns.
 */
export const MAX_POOL_HOPS = 8;
/** Routes one order may be split across. The router splits into two to four. */
export const MAX_POOL_SPLITS = 16;

const POSITIVE = /^[1-9]\d*$/;
/** The Cosmos SDK's own denom rule. */
const DENOM = /^[a-zA-Z][a-zA-Z0-9/:._-]{2,127}$/;

/* -------------------------------------------------------------------------- *
 * Routes
 * -------------------------------------------------------------------------- */

/** One pool on a route, and the denom it pays out. */
export interface PoolHop {
  /** Pool id, decimal digits. */
  readonly poolId: string;
  readonly tokenOutDenom: string;
}

/** One route of an order: its pools in order, and the input it takes. */
export interface PoolRoute {
  readonly hops: readonly PoolHop[];
  /** Base units of the input this route swaps. All routes add up to the whole input. */
  readonly inAmount: string;
}

/**
 * The problems with a set of routes for selling `amountIn` into `outputDenom`,
 * in the chain's own terms: at least one route, none longer than
 * {@link MAX_POOL_HOPS}, no more than {@link MAX_POOL_SPLITS}, every pool id a
 * positive integer, every denom a denom, every route ending in `outputDenom`,
 * every route taking a positive amount, the amounts adding up to `amountIn`,
 * and no two routes through the same pools (the chain refuses duplicates).
 */
function routeProblem(routes: readonly PoolRoute[], amountIn: string, outputDenom: string): string | null {
  if (!POSITIVE.test(amountIn)) return "the amount is not a positive integer";
  if (routes.length === 0) return "there is no route";
  if (routes.length > MAX_POOL_SPLITS) return `the order is split ${routes.length} ways`;
  let total = 0n;
  const seen = new Set<string>();
  for (const route of routes) {
    if (route.hops.length === 0) return "a route has no pool";
    if (route.hops.length > MAX_POOL_HOPS) return `a route passes ${route.hops.length} pools`;
    for (const hop of route.hops) {
      if (!POSITIVE.test(hop.poolId)) return `pool id ${hop.poolId} is not a pool id`;
      if (!DENOM.test(hop.tokenOutDenom)) return `${hop.tokenOutDenom} is not a denom`;
    }
    if (route.hops[route.hops.length - 1]?.tokenOutDenom !== outputDenom) {
      return `a route ends in another token than ${outputDenom}`;
    }
    if (!POSITIVE.test(route.inAmount)) return "a route takes no input";
    total += BigInt(route.inAmount);
    const key = route.hops.map((hop) => hop.poolId).join(">");
    if (seen.has(key)) return "two routes pass the same pools";
    seen.add(key);
  }
  if (total !== BigInt(amountIn)) return "the routes do not add up to the amount";
  return null;
}

/**
 * The router's routes for `quote`, as poolmanager takes them. `null` when they
 * are not a valid order for exactly `amountIn` of the quote's input: a split
 * that does not add up would sell another amount than the one reviewed.
 */
export function poolRoutesOf(
  quote: Pick<OsmosisSwapQuote, "splits" | "outputDenom">,
  amountIn: string,
): PoolRoute[] | null {
  const routes = quote.splits.map((split) => ({
    hops: split.pools.map((pool) => ({ poolId: pool.poolId, tokenOutDenom: pool.tokenOutDenom })),
    inAmount: split.inAmount,
  }));
  return routeProblem(routes, amountIn, quote.outputDenom) === null ? routes : null;
}

/**
 * The least the swap may pay out: the quote's output less `slippagePercent`,
 * rounded down. `null` when that is nothing, because a floor of 0 is no floor:
 * the chain would accept any price at all.
 */
export function poolMinOut(quote: Pick<OsmosisSwapQuote, "outputAmount">, slippagePercent: number): string | null {
  try {
    const floor = applySlippage(quote.outputAmount, slippagePercent);
    return POSITIVE.test(floor) ? floor : null;
  } catch {
    return null;
  }
}

/** The routes in words: `pool 3586`, `pools 3497 → 1464`, or `2 routes: pool 3498 (60%) and pool 3586 (40%)`. */
export function poolRouteText(routes: readonly PoolRoute[]): string {
  const one = (route: PoolRoute) =>
    route.hops.length === 1
      ? `pool ${route.hops[0]?.poolId ?? ""}`
      : `pools ${route.hops.map((hop) => hop.poolId).join(" → ")}`;
  if (routes.length === 1 && routes[0]) return one(routes[0]);
  const total = routes.reduce((sum, route) => sum + BigInt(route.inAmount), 0n);
  const share = (route: PoolRoute) => {
    if (total <= 0n) return "";
    const percent = Number((BigInt(route.inAmount) * 1000n) / total) / 10;
    return ` (${Number.isInteger(percent) ? percent.toFixed(0) : percent.toFixed(1)}%)`;
  };
  const parts = routes.map((route) => `${one(route)}${share(route)}`);
  return `${routes.length} routes: ${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1] ?? ""}`;
}

/* -------------------------------------------------------------------------- *
 * The message
 * -------------------------------------------------------------------------- */

/**
 * The poolmanager message selling `denom` along `routes` for at least
 * `minOut`: `MsgSwapExactAmountIn` for one route, which takes the whole input
 * as `token_in`; `MsgSplitRouteSwapExactAmountIn` for several, each with its
 * share as `token_in_amount`. Throws on routes that are not a valid order:
 * nothing calls this with routes {@link poolRoutesOf} refused.
 */
export function buildPoolSwapMsg(args: {
  readonly sender: string;
  readonly denom: string;
  readonly routes: readonly PoolRoute[];
  readonly minOut: string;
}): BuiltMsg {
  const { sender, denom, routes, minOut } = args;
  const amount = routes.reduce((sum, route) => sum + BigInt(route.inAmount), 0n).toString();
  const outputDenom = routes[0]?.hops[routes[0].hops.length - 1]?.tokenOutDenom ?? "";
  const problem = routeProblem(routes, amount, outputDenom);
  if (problem) throw new Error(`Zunia will not build this swap: ${problem}.`);
  if (!DENOM.test(denom)) throw new Error(`Zunia will not build this swap: ${denom} is not a denom.`);
  if (!POSITIVE.test(minOut)) throw new Error("Zunia will not build a swap without a minimum output.");
  const pools = (route: PoolRoute) =>
    route.hops.map((hop) => ({ pool_id: hop.poolId, token_out_denom: hop.tokenOutDenom }));
  const [only] = routes;
  if (routes.length === 1 && only) {
    return {
      typeUrl: POOL_SWAP_TYPE_URL,
      value: {
        sender,
        routes: pools(only),
        token_in: { denom, amount: only.inAmount },
        token_out_min_amount: minOut,
      },
    };
  }
  return {
    typeUrl: POOL_SPLIT_SWAP_TYPE_URL,
    value: {
      sender,
      routes: routes.map((route) => ({ pools: pools(route), token_in_amount: route.inAmount })),
      token_in_denom: denom,
      token_out_min_amount: minOut,
    },
  };
}

/** A coin exactly as a message carries it. */
export interface PoolCoin {
  readonly denom: string;
  /** Base units, digits only. */
  readonly amount: string;
}

/** A poolmanager swap, read from the message that is signed. */
export interface PoolSwapFacts {
  /** `MsgSplitRouteSwapExactAmountIn` rather than `MsgSwapExactAmountIn`. */
  readonly split: boolean;
  readonly sender: string;
  /** What leaves the account: the input denom, and every route's input added up. */
  readonly sold: PoolCoin;
  /** What the last pool of every route pays out. */
  readonly outputDenom: string;
  /** `token_out_min_amount`: below it the chain refuses the transaction. */
  readonly minOut: string;
  readonly routes: readonly PoolRoute[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Exactly these keys: a field this reader does not know could change what the chain does unseen. */
function hasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function readHops(raw: unknown): PoolHop[] | null {
  if (!Array.isArray(raw)) return null;
  const hops: PoolHop[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || !hasKeys(entry, ["pool_id", "token_out_denom"])) return null;
    const { pool_id: poolId, token_out_denom: tokenOutDenom } = entry;
    if (typeof poolId !== "string" || typeof tokenOutDenom !== "string") return null;
    hops.push({ poolId, tokenOutDenom });
  }
  return hops;
}

/**
 * Read a poolmanager swap from the message that is signed. `null` for any
 * other message, and for one with a field this reader does not know, a number
 * that is not canonical, or routes that are not a valid order (see
 * {@link routeProblem}): what cannot be read whole is never described, and
 * never signed.
 */
export function readPoolSwapMsg(msg: BuiltMsg | undefined): PoolSwapFacts | null {
  if (!msg) return null;
  const value: Record<string, unknown> = msg.value;
  const { sender, token_out_min_amount: minOut } = value;
  if (typeof sender !== "string" || sender === "") return null;
  if (typeof minOut !== "string" || !POSITIVE.test(minOut)) return null;

  let routes: PoolRoute[];
  let denom: unknown;
  if (msg.typeUrl === POOL_SWAP_TYPE_URL) {
    if (!hasKeys(value, ["sender", "routes", "token_in", "token_out_min_amount"])) return null;
    const tokenIn = value.token_in;
    if (!isRecord(tokenIn) || !hasKeys(tokenIn, ["denom", "amount"])) return null;
    const hops = readHops(value.routes);
    if (!hops || typeof tokenIn.amount !== "string") return null;
    denom = tokenIn.denom;
    routes = [{ hops, inAmount: tokenIn.amount }];
  } else if (msg.typeUrl === POOL_SPLIT_SWAP_TYPE_URL) {
    if (!hasKeys(value, ["sender", "routes", "token_in_denom", "token_out_min_amount"])) return null;
    if (!Array.isArray(value.routes)) return null;
    routes = [];
    for (const entry of value.routes) {
      if (!isRecord(entry) || !hasKeys(entry, ["pools", "token_in_amount"])) return null;
      const hops = readHops(entry.pools);
      if (!hops || typeof entry.token_in_amount !== "string") return null;
      routes.push({ hops, inAmount: entry.token_in_amount });
    }
    denom = value.token_in_denom;
  } else {
    return null;
  }
  if (typeof denom !== "string" || !DENOM.test(denom)) return null;
  const outputDenom = routes[0]?.hops[routes[0].hops.length - 1]?.tokenOutDenom ?? "";
  const amount = routes.reduce(
    (sum, route) => (POSITIVE.test(route.inAmount) ? sum + BigInt(route.inAmount) : sum),
    0n,
  );
  if (routeProblem(routes, amount.toString(), outputDenom) !== null) return null;
  return {
    split: msg.typeUrl === POOL_SPLIT_SWAP_TYPE_URL,
    sender,
    sold: { denom, amount: amount.toString() },
    outputDenom,
    minOut,
    routes,
  };
}

/** Whether two sets of routes are the same order, pool for pool and amount for amount. */
export function sameRoutes(a: readonly PoolRoute[], b: readonly PoolRoute[]): boolean {
  return (
    a.length === b.length &&
    a.every((route, index) => {
      const other = b[index];
      return (
        other !== undefined &&
        route.inAmount === other.inAmount &&
        route.hops.length === other.hops.length &&
        route.hops.every(
          (hop, at) =>
            hop.poolId === other.hops[at]?.poolId && hop.tokenOutDenom === other.hops[at]?.tokenOutDenom,
        )
      );
    })
  );
}

/** An ICS20 transfer that sends a swap's output on, read from the message that is signed. */
export interface DeliveryTransferFacts {
  readonly sourcePort: string;
  readonly sourceChannel: string;
  readonly token: PoolCoin;
  readonly sender: string;
  readonly receiver: string;
  readonly memo: string;
  /** Nanoseconds since the epoch, digits; `"0"` when the transfer sets none. */
  readonly timeoutTimestamp: string;
}

const TRANSFER_KEYS: ReadonlySet<string> = new Set([
  "source_port",
  "source_channel",
  "token",
  "sender",
  "receiver",
  "timeout_height",
  "timeout_timestamp",
  "memo",
]);

/** Read the transfer a `pool-deliver` swap signs after the swap; `null` for anything else. */
export function readDeliveryTransfer(msg: BuiltMsg | undefined): DeliveryTransferFacts | null {
  if (!msg || msg.typeUrl !== TRANSFER_TYPE_URL) return null;
  const value: Record<string, unknown> = msg.value;
  if (!Object.keys(value).every((key) => TRANSFER_KEYS.has(key))) return null;
  const { source_port, source_channel, token, sender, receiver, timeout_timestamp } = value;
  const memo = value.memo ?? "";
  if (
    typeof source_port !== "string" ||
    typeof source_channel !== "string" ||
    typeof sender !== "string" ||
    typeof receiver !== "string" ||
    typeof memo !== "string"
  ) {
    return null;
  }
  if (!isRecord(token) || !hasKeys(token, ["denom", "amount"])) return null;
  const { denom, amount } = token;
  if (typeof denom !== "string" || typeof amount !== "string" || !POSITIVE.test(amount)) return null;
  // A height timeout, when present, is the two counters and nothing else.
  const height = value.timeout_height;
  if (height !== undefined) {
    if (!isRecord(height) || !Object.keys(height).every((key) => key === "revision_number" || key === "revision_height")) {
      return null;
    }
    if (!Object.values(height).every((part) => typeof part === "string" && /^\d+$/.test(part))) return null;
  }
  const timeout =
    timeout_timestamp === undefined ? "0" : typeof timeout_timestamp === "string" ? timeout_timestamp : null;
  if (timeout === null || !/^\d+$/.test(timeout)) return null;
  return {
    sourcePort: source_port,
    sourceChannel: source_channel,
    token: { denom, amount },
    sender,
    receiver,
    memo,
    timeoutTimestamp: timeout,
  };
}

/* -------------------------------------------------------------------------- *
 * Pricing
 * -------------------------------------------------------------------------- */

/** What to price in Osmosis's pools. */
export interface PoolQuoteInput {
  /** The input as Osmosis names it. */
  readonly venueInputDenom: string;
  /** The output as Osmosis names it. */
  readonly venueOutputDenom: string;
  /** Base units the swap sells: what is left after the Zunia fee. */
  readonly amountBaseUnits: string;
  readonly slippagePercent: number;
  readonly signal?: AbortSignal;
}

/** Why a pool swap has no price, so a screen can word it with the tickers. */
export type PoolQuoteBlockedCode = "same-token" | "no-pool-route" | "routes-invalid" | "no-floor";

/** A price in Osmosis's pools and the order it makes, or why there is none. */
export interface PoolQuote {
  readonly quote: OsmosisSwapQuote | null;
  /** The router's routes for exactly the amount sold. */
  readonly routes: readonly PoolRoute[] | null;
  /** The floor at the slippage asked: what the message will say. */
  readonly minOut: string | null;
  readonly error: string | null;
  readonly code: PoolQuoteBlockedCode | null;
}

const NO_POOL_ROUTE = "Osmosis has no pool route for this pair at this amount, so there is nothing to sign.";
const ROUTES_INVALID =
  "The Osmosis router's routes for this swap do not add up to the amount you sell, so Zunia will not sign them.";
const NO_FLOOR =
  "At this amount the swap would pay out so little that its minimum rounds to nothing, so Zunia will not sign it.";

/**
 * Price selling `amountBaseUnits` of `venueInputDenom` for `venueOutputDenom`
 * in Osmosis's pools, along the router's best route (split when that pays
 * more), and work out the order and the floor the message will carry.
 */
export async function quotePoolSwap(input: PoolQuoteInput): Promise<PoolQuote> {
  const none = (error: string, code: PoolQuoteBlockedCode | null): PoolQuote => ({
    quote: null,
    routes: null,
    minOut: null,
    error,
    code,
  });
  if (input.venueInputDenom === input.venueOutputDenom) {
    return none("Both sides are the same token on Osmosis, so there is nothing to swap.", "same-token");
  }
  const venue = chainRegistry().get(VENUE);
  if (!venue) return none(`${VENUE} is not in this wallet's chain list.`, null);
  let quote: OsmosisSwapQuote;
  try {
    quote = await quoteOsmosisSwap(
      {
        tokenInDenom: input.venueInputDenom,
        tokenInAmount: input.amountBaseUnits,
        tokenOutDenom: input.venueOutputDenom,
        slippagePercent: input.slippagePercent,
        router: swapRouterClient(),
        ...(input.signal ? { request: { signal: input.signal } } : {}),
      },
      lcdFor(venue),
    );
  } catch (error) {
    if (isInterchainError(error) && error.code === "no-route") return none(NO_POOL_ROUTE, "no-pool-route");
    return none(describeInterchainError(error), null);
  }
  const routes = poolRoutesOf(quote, input.amountBaseUnits);
  if (!routes) return { ...none(ROUTES_INVALID, "routes-invalid"), quote };
  const minOut = poolMinOut(quote, input.slippagePercent);
  if (!minOut) return { ...none(NO_FLOOR, "no-floor"), quote };
  return { quote, routes, minOut, error: null, code: null };
}

/* -------------------------------------------------------------------------- *
 * Delivery to another chain
 * -------------------------------------------------------------------------- */

/** What the transfer after a `pool-deliver` swap needs. */
export interface PoolDeliveryInput {
  readonly destChainId: string;
  /** The denom the To row names on its chain: what must arrive there. */
  readonly destDenom: string;
  /** The swap's output as Osmosis names it: what the transfer sends. */
  readonly venueOutputDenom: string;
  /** Base units the transfer will send. Any amount plans the same channels. */
  readonly amountBaseUnits: string;
  /** The signer on Osmosis: the swap pays it, and the transfer leaves it. */
  readonly sender: string;
  /** This wallet's own address on the destination chain. */
  readonly recipient: string;
  readonly manualChannels?: readonly ManualChannel[];
  readonly resolveAddresses: (chainIds: readonly string[]) => Promise<Readonly<Record<string, string>>>;
  readonly signal?: AbortSignal;
}

/** The checked transfer leg, or why there is none. */
export interface PoolDelivery {
  readonly view: RoutePlanView | null;
  readonly error: string | null;
}

/**
 * Plan the transfer that sends a swap's output from Osmosis to the To's chain:
 * one direct hop, no memo, over a channel checked on both chains, delivering
 * exactly the To's denom. Anything else (a forward through another chain, a
 * route that would arrive as another variant) is refused rather than signed
 * behind a swap.
 */
export async function planPoolDelivery(input: PoolDeliveryInput): Promise<PoolDelivery> {
  const planned = await planTransfer({
    sourceChainId: VENUE,
    destChainId: input.destChainId,
    inputDenom: input.venueOutputDenom,
    amountBaseUnits: input.amountBaseUnits,
    sender: input.sender,
    recipient: input.recipient,
    resolveAddresses: input.resolveAddresses,
    ...(input.manualChannels ? { manualChannels: input.manualChannels } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (planned.error) return { view: null, error: planned.error };
  const view = planned.best;
  if (!view) {
    return {
      view: null,
      error: planned.warnings[0] ?? "Zunia found no channel from Osmosis to deliver this token.",
    };
  }
  if (view.blockedReason) return { view, error: view.blockedReason };
  const { plan } = view;
  if (plan.hops.length !== 1 || plan.memo !== "") {
    return {
      view,
      error:
        "Delivering this token from Osmosis needs a route through another chain, which Zunia does not sign behind a swap. Swap to the token on Osmosis, then send it.",
    };
  }
  if (plan.outputDenom !== input.destDenom) {
    return {
      view,
      error:
        "The transfer from Osmosis would deliver another variant of this token than the one you picked, so the swap stays unsigned.",
    };
  }
  return { view, error: null };
}

/* -------------------------------------------------------------------------- *
 * One plan
 * -------------------------------------------------------------------------- */

/** What planning a swap in Osmosis's pools needs. */
export interface PoolSwapPlanInput {
  /** The input as Osmosis names it. */
  readonly venueInputDenom: string;
  /** The output as Osmosis names it. */
  readonly venueOutputDenom: string;
  /** Base units the swap on Osmosis sells. */
  readonly amountBaseUnits: string;
  readonly slippagePercent: number;
  /**
   * The transfer leg of a `pool-deliver` swap, planned once the price gives
   * the amount it will send. `null` or absent for a swap delivered on Osmosis.
   */
  readonly delivery?: Omit<PoolDeliveryInput, "venueOutputDenom" | "amountBaseUnits" | "signal"> | null;
  readonly signal?: AbortSignal;
}

/** A planned pool swap: the price, and for `pool-deliver` the checked transfer leg. */
export interface PoolSwapPlan {
  readonly venueInputDenom: string;
  readonly venueOutputDenom: string;
  /** Base units priced: what the swap sells. */
  readonly amountBaseUnits: string;
  readonly quote: PoolQuote;
  /** `null` when no transfer was asked for, or there was no price to send. */
  readonly delivery: PoolDelivery | null;
}

/**
 * Price a pool swap, then plan the transfer that sends its floor on when one
 * is asked for. A denom that is not one is refused before anything is read.
 */
export async function planPoolSwap(input: PoolSwapPlanInput): Promise<PoolSwapPlan> {
  const base = {
    venueInputDenom: input.venueInputDenom,
    venueOutputDenom: input.venueOutputDenom,
    amountBaseUnits: input.amountBaseUnits,
  };
  if (!DENOM.test(input.venueInputDenom) || !DENOM.test(input.venueOutputDenom)) {
    return {
      ...base,
      quote: {
        quote: null,
        routes: null,
        minOut: null,
        error: "Zunia could not name both tokens on Osmosis, so it will not put a guessed denom in the swap.",
        code: null,
      },
      delivery: null,
    };
  }
  const quote = await quotePoolSwap({
    venueInputDenom: input.venueInputDenom,
    venueOutputDenom: input.venueOutputDenom,
    amountBaseUnits: input.amountBaseUnits,
    slippagePercent: input.slippagePercent,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const delivery =
    input.delivery && quote.minOut
      ? await planPoolDelivery({
          ...input.delivery,
          venueOutputDenom: input.venueOutputDenom,
          amountBaseUnits: quote.minOut,
          ...(input.signal ? { signal: input.signal } : {}),
        })
      : null;
  return { ...base, quote, delivery };
}
