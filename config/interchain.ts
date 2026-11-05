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
 *
 * The one entry answered on 2026-10-05 with label "CrossChainSwaps v1.2",
 * code 37. A second candidate, `osmo1efakw4…ddqgg`, was listed until 0.1.3 and
 * removed: the Osmosis LCD answers "no such contract" for it, so it could never
 * become the venue and only added a second "absent" check.
 */
export const XCS_CONTRACT_CANDIDATES: readonly string[] = [
  "osmo1uwk8xc6q0s6t5qcpr6rht3sczu6du83xq8pwxjua0hfj5hzcnh3sqxwvxs",
];

/**
 * Skip Go's contracts on Osmosis, which swap a token that arrives by IBC and
 * deliver the result, all from the one transfer the user signs.
 *
 * The crosschain-swaps contract above executes only the pairs in its router's
 * table (39 on 2026-10-05, none with Safrochain's SAF), and its v2 refuses
 * SAF outright ("channel to chain link not registered: channel-110497"). Skip's
 * entry point takes the pools and the channel out in the memo, so it swaps any
 * pair the Osmosis router prices, and pays out on Osmosis or over any channel.
 *
 * Source: skip-mev/skip-go-cosmwasm-contracts, deployed-contracts/osmosis/
 * mainnet.toml at e2bffe67 (deployed 2024-07-11). All three are immutable
 * (no admin) on Osmosis. Checked before use like the venue above:
 * `verifySkipEntryPoint()` reads the entry point's contract info and the path
 * stays off unless the code id, the label and the empty admin all match.
 * Simulated on Osmosis mainnet on 2026-11-06: SAF to allUSDC in pool 3600
 * paid on Osmosis, and allUSDC to SAF sent back to Safrochain on channel-110497.
 */
export const SKIP_ENTRY_POINT = {
  address: "osmo10a3k4hvk37cc4hnxctw4p95fhscd2z6h2rmx0aukc6rm8u9qqx9smfsh7u",
  codeId: "1241",
  label: "Skip Swap Entry Point",
} as const;

/** Skip's poolmanager swap adapter the entry point calls (code 1240). */
export const SKIP_POOLMANAGER_ADAPTER = "osmo1xzphwrc9aahmq7smwaggukwx5w2w8mmtqf5mk0ky0v6hh75paxsszfnlu5";

/** Skip's IBC transfer adapter, which sends the output on (code 1239). */
export const SKIP_IBC_ADAPTER = "osmo1m8wg4vxkefhs374qxmmqpyusgz289wmulex5qdwpfx7jnrxzer5s9cv83q";

/** The swap venue name Skip's entry point maps to the poolmanager adapter. */
export const SKIP_SWAP_VENUE = "osmosis-poolmanager";

/**
 * How long Skip's entry point accepts the swap, in minutes after signing.
 * Longer than {@link PACKET_TIMEOUT_MINUTES}: a packet that arrives at all
 * arrives before it, and a swap that runs later is refused and refunded.
 */
export const SKIP_SWAP_TIMEOUT_MINUTES = 15;

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
 * How long a swap price counts as current. Past it the form fetches a new one
 * on its own, and the confirm screen will not sign until the user refreshes.
 */
export const QUOTE_TTL_MS = 20_000;

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
 * Each template is the chain's `explorers[].tx_page` in cosmos/chain-registry
 * (read September 2026): Mintscan where the registry lists it, otherwise the
 * explorer the registry names for that chain. The chain registry fork this
 * extension ships carries no explorer URLs, and a guessed domain is worse than
 * none (it 404s or shows somebody else's chain), so a chain missing here keeps
 * its hashes as selectable text. Add entries only from the same source.
 */
export const EXPLORER_TX_URLS: Readonly<Record<string, string>> = {
  "safrochain-1": "https://explorer.safrochain.com/tx/{hash}",
  "safro-testnet-1": "https://explorer.testnet.safrochain.com/transactions/{hash}",
  "cosmoshub-4": "https://www.mintscan.io/cosmos/transactions/{hash}",
  "osmosis-1": "https://www.mintscan.io/osmosis/transactions/{hash}",
  "akashnet-2": "https://www.mintscan.io/akash/transactions/{hash}",
  "archway-1": "https://archway.explorers.guru/transaction/{hash}",
  "axelar-dojo-1": "https://www.mintscan.io/axelar/transactions/{hash}",
  celestia: "https://celestia.explorers.guru/transaction/{hash}",
  "dydx-mainnet-1": "https://www.mintscan.io/dydx/txs/{hash}",
  "dymension_1100-1": "https://www.mintscan.io/dymension/tx/{hash}",
  "evmos_9001-2": "https://www.mintscan.io/evmos/transactions/{hash}",
  "injective-1": "https://www.mintscan.io/injective/transactions/{hash}",
  "juno-1": "https://ezstaking.app/juno/txs/{hash}",
  "kaiyo-1": "https://finder.kujira.app/kaiyo-1/tx/{hash}",
  "mantra-1": "https://mintscan.io/mantra/txs/{hash}",
  "neutron-1": "https://www.mintscan.io/neutron/transactions/{hash}",
  "noble-1": "https://www.mintscan.io/noble/txs/{hash}",
  "phoenix-1": "https://www.mintscan.io/terra/transactions/{hash}",
  "secret-4": "https://www.mintscan.io/secret/transactions/{hash}",
  "sentinelhub-2": "https://explorer.sentinel.co/transactions/{hash}",
  "stride-1": "https://www.mintscan.io/stride/transactions/{hash}",
};

/** Explorer URL for a hash, or `null` when this host has no explorer for the chain. */
export function explorerTxUrl(chainId: string, txHash: string): string | null {
  const template = EXPLORER_TX_URLS[chainId];
  if (!template) return null;
  return template.replace("{hash}", encodeURIComponent(txHash));
}
