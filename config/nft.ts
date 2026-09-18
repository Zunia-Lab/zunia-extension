/**
 * Host configuration for the NFT surface.
 *
 * Same rule as `config/interchain.ts`: everything here is deployment data, not
 * protocol data, and nothing here is trusted without a check.
 *
 * Two of these maps ship empty on purpose. A CW721 address is not guessable and
 * a wrong one is not harmless - a curated list that names the wrong contract
 * makes the wallet query a stranger's collection and present it as the user's,
 * and a wrong cw-ics721 bridge address turns "send my NFT to Osmosis" into
 * "hand my NFT to an unknown contract", which is irreversible. So the shipped
 * defaults are empty, the UI says exactly which discovery path found nothing
 * and why, and the user's own contract address is the path that always works.
 */

import type { NftIndexer } from "@zunialab/interchain";

/**
 * CW721 collections the wallet probes without being asked, per chain.
 *
 * EMPTY. CosmWasm has no chain-level "tokens by owner" index, so a curated list
 * is one of only three ways to find anything (see `NFT_DISCOVERY_LIMITATION` in
 * the engine). It stays empty until an address has been verified on chain,
 * because the failure mode of a wrong entry is a wallet confidently showing a
 * collection the user does not hold, or a `contract-error` the user cannot act
 * on. Add entries as `{"<chainId>": ["<bech32 contract>"]}`; each is still
 * probed with a real `tokens` query, so a stale entry costs one request and
 * never a wrong claim.
 */
export const NFT_KNOWN_CONTRACTS: Readonly<Record<string, readonly string[]>> =
  {};

/**
 * Chain-specific NFT indexers, keyed by chain id.
 *
 * EMPTY. An indexer is the only way to promise a *complete* list, and
 * `NftDiscoveryResult.complete` is true only when one answered. There is no
 * shared protocol for these services - Stargaze speaks GraphQL, others speak
 * something else - so the engine takes an interface rather than a URL and the
 * host has to write a real client per chain. `zunia-indexer` in this workspace
 * indexes transactions only and has no CW721 tables, so there is nothing to
 * wire up yet and the UI says so instead of implying completeness.
 */
export const NFT_INDEXERS: Readonly<Record<string, NftIndexer>> = {};

/**
 * cw-ics721 bridge contracts, keyed by the chain they are deployed on.
 *
 * EMPTY. This is the contract that escrows the NFT and mints a debt voucher on
 * the far side; sending `send_nft` to the wrong address gives the NFT away with
 * no packet, no refund and no recovery path. Addresses are per-deployment and
 * are never protocol constants, so there is no defensible default. The user can
 * pin one from the transfer screen and `verifyNftBridge()` checks it against
 * the chain's `/cosmwasm/wasm/v1/contract/{addr}` before any control is
 * enabled.
 */
export const ICS721_BRIDGE_CONTRACTS: Readonly<Record<string, string>> = {};

/**
 * IPFS gateways used to turn `ipfs://...` into something a browser can load.
 *
 * Only ever consulted when the user has turned artwork on: whichever gateway
 * answers learns their IP address and which token they are looking at, and for
 * a whole grid it learns the shape of their holdings. Both entries are run by
 * Protocol Labs. The engine ships no default gateway on purpose, so this list
 * is the only thing that makes `ipfs://` resolvable at all - emptying it turns
 * artwork off for IPFS tokens rather than breaking anything.
 */
export const IPFS_GATEWAYS: readonly string[] = [
  "https://ipfs.io/ipfs/",
  "https://dweb.link/ipfs/",
];

/** Arweave gateways for `ar://...`. Same privacy trade-off as the IPFS list. */
export const ARWEAVE_GATEWAYS: readonly string[] = ["https://arweave.net/"];

/**
 * Contracts probed in one discovery run.
 *
 * These are public LCD nodes and each contract is a separate wasm smart query,
 * so the cap is about not being rate-limited rather than about time. The user's
 * own addresses are never dropped by it - the engine exempts them.
 */
export const NFT_MAX_CONTRACTS = 20;

/** Token ids read per collection before the list is marked truncated. */
export const NFT_MAX_TOKENS_PER_CONTRACT = 60;

/**
 * Tokens whose on-chain detail (`all_nft_info`) is read for the grid.
 *
 * Each one is a request, so the grid renders from token ids immediately and
 * fills in names and artwork behind them. Past this cap the cards keep their id
 * and the screen says the rest were not read, which is true and cheap; opening
 * a token always reads that one token in full.
 */
export const NFT_DETAIL_PREFETCH = 24;

/** Detail reads in flight at once. Small on purpose: public nodes rate-limit. */
export const NFT_DETAIL_CONCURRENCY = 3;

/** ICS721 packet timeout, in minutes. Matches the ICS20 timeout used elsewhere. */
export const ICS721_TIMEOUT_MINUTES = 10;

/**
 * Bytes of off-chain metadata JSON the wallet will read.
 *
 * A `token_uri` host is untrusted and can serve a gigabyte. The fetcher stops
 * reading past this and reports the token's metadata as unavailable rather than
 * filling the popup's heap.
 */
export const NFT_METADATA_MAX_BYTES = 512 * 1024;

/** Timeout for one off-chain metadata read. */
export const NFT_METADATA_TIMEOUT_MS = 8_000;
