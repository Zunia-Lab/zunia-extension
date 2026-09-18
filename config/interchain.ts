/**
 * Host configuration for the interchain engine (`@zunialab/interchain`).
 *
 * Everything here is deployment data, not protocol data. The engine ships no
 * contract addresses and no per-chain middleware list on purpose: a wrong
 * crosschain-swaps address in a memo sends funds to a contract that will not
 * send them back, and a chain that does not actually run ibc-hooks silently
 * ignores the memo and delivers a plain transfer to a contract address.
 *
 * Nothing in this file is trusted without a check. `XCS_CONTRACT_CANDIDATES`
 * are addresses seen in Osmosis governance and documentation and are treated as
 * *unverified*: `lib/interchain.ts` queries the chain for the contract before
 * any swap control is enabled, and the feature fails closed with a named reason
 * when the address is unset, unreachable or absent on chain.
 */

/** The chain the crosschain-swap contract runs on. */
export const SWAP_VENUE_CHAIN_ID = "osmosis-1";

/**
 * Crosschain-swaps addresses seen in Osmosis governance and docs, highest
 * confidence first.
 *
 * UNVERIFIED. Recorded here so the wallet has something to check rather than
 * something to trust; `verifySwapVenue()` reads
 * `/cosmwasm/wasm/v1/contract/{addr}` on the venue chain and only then is the
 * swap path enabled. Never inline one of these at a call site.
 */
export const XCS_CONTRACT_CANDIDATES: readonly string[] = [
  "osmo1uwk8xc6q0s6t5qcpr6rht3sczu6du83xq8pwxjua0hfj5hzcnh3sqxwvxs",
  "osmo1efakw4was99usxve258p58a5a26f0yt072gvyej5zr4lv5r0hxqqsddqgg",
];

/**
 * Public SQS router hosts, in priority order.
 *
 * The pool graph is not on chain in a form the LCD can search by denom pair, so
 * without a router the wallet cannot price a swap and the confirm control stays
 * disabled. Mirrors `OSMOSIS_ROUTER_ENDPOINTS` in the engine; kept as host
 * config so a self-hosted router can replace it without touching the engine.
 */
export const SWAP_ROUTER_ENDPOINTS: readonly string[] = [
  "https://sqs.osmosis.zone",
  "https://sqsprod.osmosis.zone",
];

/**
 * Slippage tolerance, as a percentage on the 0-100 scale the swaprouter reads
 * (`percentage_impact.div(100)`), not a 0-1 fraction.
 *
 * 1% is the engine's default and a defensible middle: tight enough that a real
 * adverse move fails the swap and refunds, loose enough that an ordinary pair
 * does not fail on normal drift between signing and packet delivery.
 */
export const DEFAULT_SLIPPAGE_PERCENT = 1;

/** Offered as one-tap choices. The user can still type any value in range. */
export const SLIPPAGE_PRESETS: readonly number[] = [0.5, 1, 3];

/**
 * Above this the UI warns before the user can confirm.
 *
 * Not a limit: a thin pool genuinely needs a wide tolerance. It is the point at
 * which the number stops being routine and the user should be told what they
 * are agreeing to lose.
 */
export const HIGH_SLIPPAGE_PERCENT = 3;

/** Refused outright. 50% tolerance is indistinguishable from no tolerance. */
export const MAX_SLIPPAGE_PERCENT = 50;

/** Per-hop ICS20 packet timeout, in minutes. Becomes the PFM `timeout` string. */
export const PACKET_TIMEOUT_MINUTES = 10;

/** Hop ceiling for route search. Each extra hop is another timeout to survive. */
export const MAX_ROUTE_HOPS = 3;

/**
 * Verified per-chain middleware support, consulted before any probe.
 *
 * Deliberately empty. The engine's probes ask the chain and answer
 * `supported` / `unsupported` / `unknown`, and `unknown` is reported to the
 * user as unconfirmed. Pinning a chain to `true` here without having verified
 * it would turn "we did not check" into "we checked", which is the failure this
 * codebase is trying to stop. Add an entry only with evidence, and say what the
 * evidence was.
 */
export const MODULE_SUPPORT_PINS: Readonly<
  Record<string, { packetForward?: boolean; ibcHooks?: boolean }>
> = {};

/**
 * Block explorers, keyed by chain id, for linking a transaction hash.
 *
 * Empty: the chain registry fork this extension ships carries no explorer URLs,
 * and a guessed explorer domain is worse than none — it either 404s or shows
 * somebody else's chain. The packet tracker renders hashes as selectable text
 * while this is empty. Add `{"<chainId>": "https://…/tx/{hash}"}` entries as
 * they are confirmed.
 */
export const EXPLORER_TX_URLS: Readonly<Record<string, string>> = {};

/** Explorer URL for a hash, or `null` when this host has no explorer for the chain. */
export function explorerTxUrl(chainId: string, txHash: string): string | null {
  const template = EXPLORER_TX_URLS[chainId];
  if (!template) return null;
  return template.replace("{hash}", encodeURIComponent(txHash));
}
