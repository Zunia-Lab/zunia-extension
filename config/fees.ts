/**
 * Zunia's swap commission.
 *
 * Decided by the owner: 0.5% of the amount sold, taken in the same
 * transaction as the swap, in the token sold, and paid to a Zunia treasury
 * address on the chain that signs the swap. lib/swap-fee.ts works the fee out,
 * builds the bank send that pays it, and checks that send before anything is
 * signed; the Swap screen shows it on the form and on the confirm screen.
 *
 * Compiled in only. Nothing here is fetched, overridden by storage or settings,
 * or changed at run time: a build charges exactly what it was released with,
 * and a reviewer reads the whole policy in this file.
 */

/** The commission, in basis points of the amount sold: 50 is 0.5%. */
export const SWAP_FEE_BPS = 50;

/**
 * The Zunia treasury on each chain a swap is signed on, by chain id.
 *
 * EMPTY until the owner provides the treasury addresses. A chain absent from
 * this map charges no commission: its swaps sign exactly the one message they
 * signed before the commission existed, byte for byte.
 *
 * How to fill it, one bech32 address per chain the swap is signed on:
 *
 * - `"osmosis-1": "osmo1…"` for swaps of funds already on Osmosis: one
 *   contract call there, with the fee as a second message beside it.
 * - One entry per source chain of a cross-chain swap (`"cosmoshub-4":
 *   "cosmos1…"`, `"noble-1": "noble1…"`, `"injective-1": "inj1…"`, …): the fee
 *   is taken there, in the token sold, in the transaction that sends the
 *   transfer to Osmosis.
 *
 * Each address must be one the owner controls on that very chain, written
 * with that chain's own prefix (the catalog's `bech32Prefix`). Never make one
 * by re-encoding another chain's address with a new prefix: chains on coin
 * type 60 (Injective and the other Ethereum-key chains) derive a different key
 * from the same seed, so an `inj1…` re-encoded from an `osmo1…` belongs to an
 * account nobody can spend from. lib/__tests__/release-consistency.test.ts
 * refuses a build whose address does not decode, checksum included, with its
 * chain's prefix, or whose coin type 60 entry carries the same bytes as
 * another chain's (a re-encoding); lib/swap-fee.ts charges nothing on a chain
 * whose entry fails the prefix check.
 *
 * @example
 * export const SWAP_FEE_RECIPIENTS: Readonly<Record<string, string>> = {
 *   "osmosis-1": "osmo1…",
 *   "cosmoshub-4": "cosmos1…",
 * };
 */
export const SWAP_FEE_RECIPIENTS: Readonly<Record<string, string>> = {};
