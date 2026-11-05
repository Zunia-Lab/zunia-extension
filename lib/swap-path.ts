/**
 * Which way Swap reaches Osmosis for one pair.
 *
 * Three venues execute a swap on Osmosis. Skip Go's entry point
 * (lib/skip-swap.ts) takes one IBC transfer from the chain holding the funds,
 * swaps along the Osmosis router's route and pays the output wherever it is
 * wanted: one signature, no OSMO. Osmosis's own pools (lib/pool-swap.ts) swap
 * funds already on Osmosis. The crosschain-swaps contract (lib/xcs-routes.ts)
 * still serves the pairs in its route table when the funds sit on Osmosis and
 * the output goes elsewhere, or when a token cannot reach Osmosis in one hop.
 */

import { SWAP_VENUE_CHAIN_ID } from "../config/interchain";
import type { TokenIdentity } from "./token-identity";

/** What the contract's route table says about a pair (lib/xcs-routes.ts `Executable`). */
type TableAnswer = "yes" | "no" | "unknown";

/**
 * - `relay`: the funds are on another chain and reach Osmosis in one hop as
 *   the denom its pools trade. One signature there: an IBC transfer whose memo
 *   has Skip's entry point swap them and pay the output on Osmosis or on the
 *   To's chain.
 * - `contract`: the crosschain-swaps contract: an IBC transfer whose memo
 *   calls it, or a call on Osmosis. It delivers the whole output wherever the
 *   To is.
 * - `pool`: the funds and the To are both on Osmosis. One poolmanager swap.
 * - `pool-deliver`: the funds are on Osmosis and the To is on another chain
 *   the contract cannot reach for this pair. One transaction: the swap, then
 *   a transfer of its guaranteed minimum to that chain.
 * - `move-first`: the funds are on another chain, cannot reach Osmosis in one
 *   hop as the token its pools trade, and the contract cannot swap the pair.
 *   They move to Osmosis first; the swap there is then `pool` or
 *   `pool-deliver`.
 */
export type SwapPath = "relay" | "contract" | "pool" | "pool-deliver" | "move-first";

/** What {@link swapPathFor} reads of the From: where it is, and what it is when known. */
export interface PathSide {
  readonly chainId: string;
  readonly identity?: Pick<TokenIdentity, "originChainId" | "osmosisDenom" | "testnet">;
}

/**
 * Whether the From reaches Osmosis in one hop as the denom its pools trade:
 * the chain's own coin, which Osmosis lists under a voucher of that chain's
 * channel (SAF on Safrochain, ATOM on the Hub, USDC.n on Noble). A voucher the
 * From's chain only holds would arrive on Osmosis as a voucher of a voucher,
 * a token no pool trades.
 */
export function relaysToVenue(from: PathSide): boolean {
  const identity = from.identity;
  return (
    from.chainId !== SWAP_VENUE_CHAIN_ID &&
    identity !== undefined &&
    !identity.testnet &&
    identity.originChainId === from.chainId &&
    identity.osmosisDenom !== null
  );
}

/**
 * The path for selling `from` and buying `to`, given the route table's answer
 * for the pair. Funds on Osmosis swap in its pools, unless the contract can
 * deliver the whole output to another chain. Funds elsewhere take Skip's entry
 * point in one signature when they reach Osmosis in one hop, and otherwise
 * the contract, unless its table says it cannot swap the pair, which moves
 * them to Osmosis first.
 */
export function swapPathFor(from: PathSide, to: { readonly chainId: string }, answer: TableAnswer): SwapPath {
  if (from.chainId === SWAP_VENUE_CHAIN_ID) {
    if (to.chainId === SWAP_VENUE_CHAIN_ID) return "pool";
    return answer === "yes" ? "contract" : "pool-deliver";
  }
  if (relaysToVenue(from)) return "relay";
  return answer === "no" ? "move-first" : "contract";
}

/** Whether the path signs a poolmanager swap now. */
export function isPoolPath(path: SwapPath | null | undefined): path is "pool" | "pool-deliver" {
  return path === "pool" || path === "pool-deliver";
}

/** Whether the path is priced in Osmosis's pools by the router: every path but the contract's. */
export function isRouterPriced(path: SwapPath | null | undefined): path is "relay" | "pool" | "pool-deliver" | "move-first" {
  return path !== null && path !== undefined && path !== "contract";
}

/** Whether the whole swap is one signature now, wherever the funds are. */
export function isOneSignature(path: SwapPath | null | undefined, tableAnswer: TableAnswer): boolean {
  return path === "relay" || isPoolPath(path) || (path === "contract" && tableAnswer === "yes");
}
