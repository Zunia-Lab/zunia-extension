/**
 * Which way Swap reaches Osmosis for one pair.
 *
 * Two venues execute a swap on Osmosis. The crosschain-swaps contract takes
 * one signature on the chain holding the funds and delivers the whole output
 * wherever it is wanted, but only for the pairs in its route table
 * (lib/xcs-routes.ts). Osmosis's own pools (lib/pool-swap.ts) swap any pair
 * they connect, but only funds already on Osmosis, and pay the signer there.
 */

import { SWAP_VENUE_CHAIN_ID } from "../config/interchain";

/** What the contract's route table says about a pair (lib/xcs-routes.ts `Executable`). */
type TableAnswer = "yes" | "no" | "unknown";

/**
 * - `contract`: the crosschain-swaps contract: an IBC transfer whose memo
 *   calls it, or a call on Osmosis. It delivers the whole output wherever the
 *   To is.
 * - `pool`: the funds and the To are both on Osmosis. One poolmanager swap.
 * - `pool-deliver`: the funds are on Osmosis and the To is on another chain
 *   the contract cannot reach for this pair. One transaction: the swap, then
 *   a transfer of its guaranteed minimum to that chain.
 * - `move-first`: the funds are on another chain and the contract cannot swap
 *   the pair. They move to Osmosis first; the swap there is then `pool` or
 *   `pool-deliver`.
 */
export type SwapPath = "contract" | "pool" | "pool-deliver" | "move-first";

/**
 * The path for selling `from` and buying `to`, given the route table's answer
 * for the pair. Funds on Osmosis swap in its pools, unless the contract can
 * deliver the whole output to another chain. Funds elsewhere use the contract
 * unless its table says it cannot swap the pair (an unreadable table leaves
 * that to the planner's live check), and otherwise move to Osmosis first.
 */
export function swapPathFor(
  from: { readonly chainId: string },
  to: { readonly chainId: string },
  answer: TableAnswer,
): SwapPath {
  if (from.chainId === SWAP_VENUE_CHAIN_ID) {
    if (to.chainId === SWAP_VENUE_CHAIN_ID) return "pool";
    return answer === "yes" ? "contract" : "pool-deliver";
  }
  return answer === "no" ? "move-first" : "contract";
}

/** Whether the path signs a poolmanager swap now. */
export function isPoolPath(path: SwapPath | null | undefined): path is "pool" | "pool-deliver" {
  return path === "pool" || path === "pool-deliver";
}
