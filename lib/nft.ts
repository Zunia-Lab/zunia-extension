/**
 * The extension's wiring of the engine's CW721 / ICS721 module.
 *
 * Every query, message shape and capability check is `@zunialab/interchain`'s.
 * This module supplies only what a host has to supply and the engine refuses to
 * guess:
 *
 * - the chain list and the LCD client, both already gated on the user's
 *   live-reads preference in `lib/interchain.ts`;
 * - the three discovery inputs (a shipped list, an indexer, the user's own
 *   contract addresses), because CosmWasm has no chain-level "tokens by owner"
 *   index and there is nothing to ask without a contract address;
 * - the cw-ics721 bridge address, which is per-deployment data, is verified
 *   against the chain before any control is enabled, and fails closed;
 * - the metadata transport, which does not exist unless the user turns artwork
 *   on. `fetchNftMetadata` takes a fetcher rather than calling `fetch` itself
 *   precisely so a host cannot leak holdings by forgetting to ask.
 *
 * Nothing here signs. Messages are built as `BuiltMsg` and handed to
 * `lib/tx-kernel.ts`, which is where the keyring lives.
 */

import {
  assertCosmWasmChain,
  base64ToJson,
  buildIcs721TransferMsg,
  buildTransferNftMsg,
  decodeBase64Utf8,
  discoverNfts,
  fetchNftMetadata,
  getCollectionInfo,
  getNftToken,
  ICS721_VOUCHER_WARNING,
  ics721TransferWarnings,
  isInterchainError,
  InterchainError,
  lcdEndpointsFromChain,
  NFT_DISCOVERY_LIMITATION,
  resolveTokenUri,
  supportsCosmWasm,
  applyNftMetadata,
  type BuiltMsg,
  type ChainInfoLike,
  type IbcChannelOption,
  type IbcChannelValidation,
  type JsonObject,
  type JsonValue,
  type NftChainContext,
  type NftCollection,
  type NftDiscoveryIssue,
  type NftDiscoverySource,
  type NftToken,
  type NftTransferRequest,
} from "@zunialab/interchain";

import {
  ARWEAVE_GATEWAYS,
  ICS721_BRIDGE_CONTRACTS,
  ICS721_TIMEOUT_MINUTES,
  IPFS_GATEWAYS,
  NFT_INDEXERS,
  NFT_KNOWN_CONTRACTS,
  NFT_MAX_CONTRACTS,
  NFT_MAX_TOKENS_PER_CONTRACT,
  NFT_METADATA_MAX_BYTES,
  NFT_METADATA_TIMEOUT_MS,
} from "../config/nft";
import { findCatalogEntry, type CatalogEntry } from "./chain-catalog";
import {
  chainRegistry,
  channelService,
  describeInterchainError,
  interchainReadsAllowed,
  lcdFor,
  READS_DISABLED_MESSAGE,
} from "./interchain";
import { STORAGE_KEYS } from "./storage-keys";

/* -------------------------------------------------------------------------- *
 * The CosmWasm gate
 * -------------------------------------------------------------------------- */

/** Why a chain cannot show NFTs, or `null` when it can. */
export interface NftChainSupport {
  readonly chainId: string;
  readonly chainName: string;
  readonly supported: boolean;
  /** One sentence naming the reason. `null` only when `supported`. */
  readonly reason: string | null;
}

/**
 * Whether this chain can hold CW721 tokens at all.
 *
 * Read straight off the registry's `features` array, which the catalog
 * generator now carries through. Three outcomes, deliberately worded
 * differently, because they are three different facts:
 *
 * - the chain is not in this wallet's list;
 * - the chain declares no `cosmwasm` (214 of the 332 registry rows);
 * - the chain publishes no feature list at all (19 rows), which is "nobody
 *   said", not "no". Even so the answer is still "unsupported": firing wasm
 *   queries at a chain with no CosmWasm module produces a `contract-error` the
 *   user cannot act on, and claiming support we have not established is the
 *   defect this wallet is trying to stop.
 */
export function nftChainSupport(chainId: string): NftChainSupport {
  const entry = findCatalogEntry(chainId);
  if (!entry) {
    return {
      chainId,
      chainName: chainId,
      supported: false,
      reason: `${chainId} is not in this wallet's chain list, so nothing can be read from it.`,
    };
  }
  if (supportsCosmWasm(entry)) {
    return { chainId, chainName: entry.chainName, supported: true, reason: null };
  }
  const reason =
    entry.features === undefined
      ? `${entry.chainName} publishes no capability list in the chain registry, so Zunia cannot confirm it runs CosmWasm. NFTs stay off rather than sending queries a chain without CosmWasm cannot answer.`
      : `${entry.chainName} does not declare the "cosmwasm" feature, so it cannot run CW721 contracts and cannot hold NFTs.`;
  return { chainId, chainName: entry.chainName, supported: false, reason };
}

/** Chains in `chainIds` that can hold NFTs, in the order given. */
export function nftCapableChainIds(
  chainIds: readonly string[],
): readonly string[] {
  return chainIds.filter((id) => nftChainSupport(id).supported);
}

function requireChain(chainId: string): CatalogEntry {
  const entry = findCatalogEntry(chainId);
  if (!entry) {
    throw new InterchainError(
      "unsupported-chain",
      `${chainId} is not in this wallet's chain list`,
      { chainId },
    );
  }
  return entry;
}

function contextFor(chainId: string): NftChainContext {
  const chain = requireChain(chainId);
  // Throws `unsupported-chain` before any request when the chain has no
  // CosmWasm, so a caller that skipped the gate still cannot query blindly.
  assertCosmWasmChain(chain);
  return { chain, lcd: lcdFor(chain) };
}

/* -------------------------------------------------------------------------- *
 * Contracts the user added
 * -------------------------------------------------------------------------- */

type ContractStore = Record<string, string[]>;

async function readContractStore(): Promise<ContractStore> {
  const raw = (await browser.storage.local.get(STORAGE_KEYS.nftContracts))[
    STORAGE_KEYS.nftContracts
  ];
  if (typeof raw !== "object" || raw === null) return {};
  const out: ContractStore = {};
  for (const [chainId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const rows = value.filter((v): v is string => typeof v === "string" && v.length > 0);
    if (rows.length > 0) out[chainId] = rows;
  }
  return out;
}

/** CW721 addresses the user pasted for one chain. */
export async function listUserContracts(chainId: string): Promise<string[]> {
  return (await readContractStore())[chainId] ?? [];
}

/**
 * Remember a contract address for a chain.
 *
 * The address is checked for the chain's own bech32 prefix and nothing more:
 * whether it is a CW721 at all is answered by the `tokens` query the next
 * discovery run makes, and the result of that query is what the UI reports.
 * Rejecting here on anything but the prefix would mean guessing.
 */
export async function addUserContract(
  chainId: string,
  address: string,
): Promise<{ ok: true; contracts: string[] } | { ok: false; error: string }> {
  const entry = findCatalogEntry(chainId);
  if (!entry) return { ok: false, error: `${chainId} is not in this wallet's chain list.` };
  const trimmed = address.trim();
  if (!trimmed) return { ok: false, error: "Enter a contract address." };
  if (!trimmed.startsWith(`${entry.bech32Prefix}1`)) {
    return {
      ok: false,
      error: `A ${entry.chainName} contract address starts with "${entry.bech32Prefix}1". Check you copied the address from the right chain.`,
    };
  }
  const store = await readContractStore();
  const current = store[chainId] ?? [];
  if (current.includes(trimmed)) {
    return { ok: false, error: "That contract is already in the list." };
  }
  store[chainId] = [...current, trimmed];
  await browser.storage.local.set({ [STORAGE_KEYS.nftContracts]: store });
  return { ok: true, contracts: store[chainId] };
}

/** Forget one contract address. */
export async function removeUserContract(
  chainId: string,
  address: string,
): Promise<string[]> {
  const store = await readContractStore();
  const next = (store[chainId] ?? []).filter((row) => row !== address);
  if (next.length > 0) store[chainId] = next;
  else delete store[chainId];
  await browser.storage.local.set({ [STORAGE_KEYS.nftContracts]: store });
  return next;
}

/* -------------------------------------------------------------------------- *
 * Discovery
 * -------------------------------------------------------------------------- */

/** One collection the owner holds something in, plus what we know about it. */
export interface NftCollectionView {
  readonly contractAddress: string;
  readonly source: NftDiscoverySource;
  readonly tokenIds: readonly string[];
  /** True when the per-contract cap cut the id list short. */
  readonly truncated: boolean;
  /** From `collection_info` / `contract_info`; null when the contract has none. */
  readonly info: NftCollection | null;
  /** Why `info` is null, when the collection read failed. Shown, never hidden. */
  readonly infoError: string | null;
}

/**
 * Which discovery paths actually ran, so the UI can never imply it looked
 * everywhere.
 *
 * This is the piece the mobile app got wrong: it rendered "you own no NFTs"
 * after querying nothing at all. Each count here is a number of contracts that
 * were really asked, and `indexer` is the name of a service that really
 * answered.
 */
export interface NftScanReport {
  /** Contracts from `config/nft.ts` for this chain. */
  readonly known: number;
  /** Contracts the user added for this chain. */
  readonly user: number;
  /** Indexer name when one answered, else `null`. */
  readonly indexer: string | null;
  /** True when no contract and no indexer was consulted: nothing was queried. */
  readonly queriedNothing: boolean;
}

/** What one discovery run found and what it cannot promise. */
export interface NftListResult {
  readonly chainId: string;
  readonly owner: string;
  readonly collections: readonly NftCollectionView[];
  readonly sources: readonly NftDiscoverySource[];
  /** True only when an indexer answered cleanly. Never true for a contract scan. */
  readonly complete: boolean;
  /** The engine's sentence about why a scan can never be complete. */
  readonly limitation: string | null;
  readonly issues: readonly NftDiscoveryIssue[];
  readonly scan: NftScanReport;
}

/**
 * Find the collections an address holds tokens in, on one chain.
 *
 * All three paths the engine exposes are used, and {@link NftScanReport} says
 * which of them contributed. A run that consulted nothing at all is reported as
 * such: an empty grid under "we asked nobody" is a different screen from an
 * empty grid under "we asked and you hold none", and conflating them is how a
 * wallet tells its user they own nothing when it never looked.
 */
export async function discoverCollections(
  chainId: string,
  owner: string,
  options: { signal?: AbortSignal } = {},
): Promise<NftListResult> {
  const ctx = contextFor(chainId);
  const knownContracts = NFT_KNOWN_CONTRACTS[chainId] ?? [];
  const userContracts = await listUserContracts(chainId);
  const indexer = NFT_INDEXERS[chainId];

  const result = await discoverNfts(ctx, owner, {
    knownContracts,
    userContracts,
    ...(indexer ? { indexer } : {}),
    maxContracts: NFT_MAX_CONTRACTS,
    maxTokensPerContract: NFT_MAX_TOKENS_PER_CONTRACT,
    ...(options.signal ? { signal: options.signal } : {}),
  });

  // Collection metadata is one extra query per collection the owner actually
  // holds something in, which is a small number. A failure here leaves the
  // collection on screen under its address rather than removing tokens the
  // owner demonstrably holds.
  const collections: NftCollectionView[] = [];
  for (const holding of result.holdings) {
    let info: NftCollection | null = null;
    let infoError: string | null = null;
    try {
      info = await getCollectionInfo(ctx, holding.contractAddress, {
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      if (isInterchainError(error) && error.code === "aborted") throw error;
      infoError = describeInterchainError(error);
    }
    collections.push({
      contractAddress: holding.contractAddress,
      source: holding.source,
      tokenIds: holding.tokenIds,
      truncated: holding.truncated,
      info,
      infoError,
    });
  }

  const indexerName = result.sources.includes("indexer") ? (indexer?.name ?? null) : null;
  return {
    chainId,
    owner,
    collections,
    sources: result.sources,
    complete: result.complete,
    limitation: result.limitation,
    issues: result.issues,
    scan: {
      known: knownContracts.length,
      user: userContracts.length,
      indexer: indexerName,
      queriedNothing:
        knownContracts.length === 0 && userContracts.length === 0 && indexer === undefined,
    },
  };
}

/** The sentence the engine wants shown whenever a list is not provably complete. */
export const NFT_LIST_LIMITATION = NFT_DISCOVERY_LIMITATION;

/* -------------------------------------------------------------------------- *
 * Tokens
 * -------------------------------------------------------------------------- */

/** One token, plus the collection name the screens show above it. */
export interface NftTokenView {
  readonly token: NftToken;
  readonly collectionName: string | null;
  /**
   * Where `token.name` / `imageUri` came from.
   *
   * `chain` means the CW721 `extension`, which is chain state. `remote` means a
   * `token_uri` host answered, which only happens after the user turned artwork
   * on. `none` means neither had anything.
   */
  readonly metadataSource: "chain" | "remote" | "none";
  /** Set when an off-chain read was attempted and failed. Shown, not swallowed. */
  readonly metadataError: string | null;
}

/**
 * Read one collection's own metadata.
 *
 * Split out from discovery because the detail screen is often reached with a
 * contract address and no prior scan - a token opened from a deep link, or a
 * collection the user has just added.
 */
export async function loadCollection(
  chainId: string,
  contractAddress: string,
  options: { signal?: AbortSignal } = {},
): Promise<NftCollection> {
  const ctx = contextFor(chainId);
  return getCollectionInfo(ctx, contractAddress, {
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/** Read one token's on-chain state, and optionally its off-chain metadata. */
export async function loadToken(
  chainId: string,
  contractAddress: string,
  tokenId: string,
  options: {
    /** Read `token_uri` from whatever host it names. Requires the user's opt-in. */
    readonly withOffChainMetadata?: boolean;
    readonly collectionName?: string | null;
    readonly signal?: AbortSignal;
  } = {},
): Promise<NftTokenView> {
  const ctx = contextFor(chainId);
  const base = await getNftToken(ctx, contractAddress, tokenId, {
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const hasChainMetadata =
    base.name !== null ||
    base.description !== null ||
    base.imageUri !== null ||
    base.attributes.length > 0;

  if (!options.withOffChainMetadata || base.tokenUri === null) {
    return {
      token: base,
      collectionName: options.collectionName ?? null,
      metadataSource: hasChainMetadata ? "chain" : "none",
      metadataError: null,
    };
  }

  try {
    const fetched = await fetchNftMetadata(base.tokenUri, {
      fetch: metadataFetcher,
      ipfsGateways: IPFS_GATEWAYS,
      arweaveGateways: ARWEAVE_GATEWAYS,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return {
      // On-chain values win; the fetched document only fills nulls.
      token: applyNftMetadata(base, fetched.metadata),
      collectionName: options.collectionName ?? null,
      metadataSource: fetched.source === "inline" ? "chain" : "remote",
      metadataError: null,
    };
  } catch (error) {
    if (isInterchainError(error) && error.code === "aborted") throw error;
    return {
      token: base,
      collectionName: options.collectionName ?? null,
      metadataSource: hasChainMetadata ? "chain" : "none",
      metadataError: describeInterchainError(error),
    };
  }
}

/* -------------------------------------------------------------------------- *
 * Off-chain metadata: the transport the user has to ask for
 * -------------------------------------------------------------------------- */

/**
 * Read one metadata document.
 *
 * Handed to the engine only when the user has turned artwork on, which is the
 * whole point of the engine taking a fetcher instead of calling `fetch`: with
 * no fetcher there is no transport and holdings cannot leak by accident.
 *
 * This implementation owns the three things a host must own against an
 * untrusted host: a timeout, a byte ceiling, and a request that carries nothing
 * about the user. `credentials: "omit"` keeps cookies off it, `referrer: ""`
 * keeps the extension id out of the request, and `redirect: "follow"` is left
 * at the default because IPFS gateways redirect to a subdomain by design.
 */
async function metadataFetcher(
  url: string,
  init: { readonly signal?: AbortSignal },
): Promise<unknown> {
  if (!(await interchainReadsAllowed())) {
    throw new InterchainError("reads-disabled", READS_DISABLED_MESSAGE);
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  init.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), NFT_METADATA_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      credentials: "omit",
      referrer: "",
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > NFT_METADATA_MAX_BYTES) {
      throw new Error(
        `Metadata document is ${declared} bytes, over the ${NFT_METADATA_MAX_BYTES}-byte limit`,
      );
    }
    const text = await response.text();
    // Re-checked after reading: a host can omit or lie about content-length.
    if (text.length > NFT_METADATA_MAX_BYTES) {
      throw new Error(`Metadata document is over the ${NFT_METADATA_MAX_BYTES}-byte limit`);
    }
    return JSON.parse(text) as unknown;
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", onAbort);
  }
}

/** A `token_uri` or `image` turned into something the popup can render. */
export interface NftMediaTarget {
  /** First URL to try, or `null` when nothing can be loaded. */
  readonly url: string | null;
  /** Every candidate, in gateway order. */
  readonly urls: readonly string[];
  /** Why there is no URL. `null` when there is one. */
  readonly reason: string | null;
}

/**
 * Resolve an `ipfs://` / `ar://` / `https://` media reference for an `<img>`.
 *
 * No I/O: this only rewrites the reference. The request happens when the
 * `<img>` mounts, which `NftMedia` does only when `loadMedia` is true - so this
 * function is safe to call whether or not the user has opted in, and the opt-in
 * is enforced by the caller passing `loadMedia`.
 *
 * Plain `http://` stays unsupported: a wallet should not quietly downgrade a
 * user's connection, and the engine's default matches.
 */
export function mediaTargetFor(uri: string | null | undefined): NftMediaTarget {
  if (!uri) {
    return { url: null, urls: [], reason: "This token carries no image reference." };
  }
  const resolved = resolveTokenUri(uri, {
    ipfsGateways: IPFS_GATEWAYS,
    arweaveGateways: ARWEAVE_GATEWAYS,
  });
  if (resolved.kind === "inline") {
    // A `data:` image never leaves the device, so it is always safe to show.
    return { url: uri, urls: [uri], reason: null };
  }
  if (resolved.kind === "unsupported" || resolved.urls.length === 0) {
    return {
      url: null,
      urls: [],
      reason: resolved.reason ?? "This image reference cannot be resolved.",
    };
  }
  return { url: resolved.urls[0] ?? null, urls: resolved.urls, reason: null };
}

/* -------------------------------------------------------------------------- *
 * The cw-ics721 bridge
 * -------------------------------------------------------------------------- */

/** Why a cross-chain NFT transfer is unavailable, in the words the UI shows. */
export type NftBridgeProblem =
  | "unset"
  | "chain-missing"
  | "no-endpoint"
  | "reads-disabled"
  | "unreachable"
  | "absent";

/** The result of checking a configured cw-ics721 bridge against the chain. */
export interface NftBridgeCheck {
  readonly chainId: string;
  /** The address that was checked, even when the check failed. */
  readonly contractAddress: string | null;
  /** Set only when the contract is really there. */
  readonly verifiedAt: number | null;
  /** The contract's own on-chain `label`, which names what is deployed. */
  readonly label: string | null;
  readonly problem: NftBridgeProblem | null;
  /** One sentence naming what is wrong and what the user can do. */
  readonly reason: string | null;
}

/** The bridge address in force for a chain: the user's pin, else the shipped map. */
export async function nftBridgeAddress(chainId: string): Promise<string | null> {
  const stored = (await browser.storage.local.get(STORAGE_KEYS.nftBridges))[
    STORAGE_KEYS.nftBridges
  ];
  const overrides =
    typeof stored === "object" && stored !== null
      ? (stored as Record<string, unknown>)
      : {};
  const pinned = overrides[chainId];
  if (typeof pinned === "string" && pinned.trim().length > 0) return pinned.trim();
  return ICS721_BRIDGE_CONTRACTS[chainId] ?? null;
}

/**
 * Pin a cw-ics721 bridge for a chain, or clear the pin with `null`.
 *
 * The escape hatch that makes the cross-chain path reachable at all while
 * `ICS721_BRIDGE_CONTRACTS` is empty. It changes *what* is verified, never
 * whether it is: the address still has to exist on chain before the transfer
 * control turns on.
 */
export async function setNftBridgeAddress(
  chainId: string,
  address: string | null,
): Promise<void> {
  bridgeCache.delete(chainId);
  const stored = (await browser.storage.local.get(STORAGE_KEYS.nftBridges))[
    STORAGE_KEYS.nftBridges
  ];
  const next: Record<string, string> =
    typeof stored === "object" && stored !== null
      ? { ...(stored as Record<string, string>) }
      : {};
  if (address === null || address.trim().length === 0) delete next[chainId];
  else next[chainId] = address.trim();
  await browser.storage.local.set({ [STORAGE_KEYS.nftBridges]: next });
}

const bridgeCache = new Map<string, { at: number; address: string; check: NftBridgeCheck }>();
const BRIDGE_CACHE_MS = 5 * 60_000;

/**
 * Confirm the cw-ics721 bridge exists on the source chain.
 *
 * Same shape and same reasoning as `verifySwapVenue` in `lib/interchain.ts`, for
 * the same reason: `send_nft` hands the token to whatever address is named, and
 * a `send_nft` to an address that is not a cw-ics721 contract either reverts
 * (best case) or lands the NFT somewhere with no way back. So the address is
 * checked against `/cosmwasm/wasm/v1/contract/{addr}` and the whole cross-chain
 * control stays off, with a named reason, until that check passes.
 */
export async function verifyNftBridge(
  chainId: string,
  options: { signal?: AbortSignal; force?: boolean } = {},
): Promise<NftBridgeCheck> {
  const address = await nftBridgeAddress(chainId);
  const failure = (
    problem: NftBridgeProblem,
    reason: string,
  ): NftBridgeCheck => ({
    chainId,
    contractAddress: address,
    verifiedAt: null,
    label: null,
    problem,
    reason,
  });

  if (!address) {
    return failure(
      "unset",
      "No cw-ics721 bridge contract is configured for this chain, so Zunia has no address to send the NFT to and will not guess one. Paste a bridge address below to enable cross-chain transfer.",
    );
  }

  const cached = bridgeCache.get(chainId);
  if (!options.force && cached && cached.address === address && Date.now() - cached.at < BRIDGE_CACHE_MS) {
    return cached.check;
  }

  const chain = chainRegistry().get(chainId);
  if (!chain) return failure("chain-missing", `${chainId} is not in this wallet's chain list.`);
  if (lcdEndpointsFromChain(chain).length === 0) {
    return failure(
      "no-endpoint",
      `${chain.chainName} has no REST endpoint in the chain list, so the bridge contract cannot be checked.`,
    );
  }

  try {
    const body = await lcdFor(chain).getJson(
      `/cosmwasm/wasm/v1/contract/${encodeURIComponent(address)}`,
      {
        cacheTtlMs: BRIDGE_CACHE_MS,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    // Narrowed by hand: a 200 carrying something else is not evidence.
    const row = body as { address?: unknown; contract_info?: unknown } | null;
    const info =
      typeof row?.contract_info === "object" && row.contract_info !== null
        ? (row.contract_info as { label?: unknown })
        : null;
    if (typeof row?.address !== "string" || row.address !== address || info === null) {
      return failure(
        "absent",
        `${address} is not a CosmWasm contract on ${chain.chainName}. Cross-chain NFT transfer stays off until a verified bridge address is configured.`,
      );
    }
    const check: NftBridgeCheck = {
      chainId,
      contractAddress: address,
      verifiedAt: Date.now(),
      label: typeof info.label === "string" ? info.label : null,
      problem: null,
      reason: null,
    };
    bridgeCache.set(chainId, { at: Date.now(), address, check });
    return check;
  } catch (error) {
    if (isInterchainError(error)) {
      if (error.code === "reads-disabled") return failure("reads-disabled", READS_DISABLED_MESSAGE);
      if (error.httpStatus === 404 || error.httpStatus === 400) {
        return failure(
          "absent",
          `${chain.chainName} has no contract at ${address}. Cross-chain NFT transfer stays off until a verified bridge address is configured.`,
        );
      }
    }
    return failure(
      "unreachable",
      `Could not reach ${chain.chainName} to check the bridge contract, so cross-chain transfer stays off rather than sending an NFT to an unchecked address.`,
    );
  }
}

/**
 * The IBC port a cw-ics721 bridge owns.
 *
 * cw-ics721 is a CosmWasm IBC contract, so its channels are bound to
 * `wasm.<contract>` and not to `transfer`. Looking for an ICS721 channel on the
 * transfer port finds ICS20 channels, which would send the NFT nowhere.
 */
export function ics721Port(bridgeContract: string): string {
  return `wasm.${bridgeContract}`;
}

/** Open ICS721 channels from `chainId` to `destChainId`, on the bridge's own port. */
export async function discoverIcs721Channels(
  chainId: string,
  destChainId: string,
  bridgeContract: string,
  options: { signal?: AbortSignal } = {},
): Promise<readonly IbcChannelOption[]> {
  return channelService().findIbcChannels(chainId, destChainId, {
    portId: ics721Port(bridgeContract),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/** Check one ICS721 channel id, on both sides. */
export async function validateIcs721Channel(
  chainId: string,
  channelId: string,
  destChainId: string | undefined,
  bridgeContract: string,
  options: { signal?: AbortSignal } = {},
): Promise<IbcChannelValidation> {
  return channelService().validateIbcChannel(chainId, channelId, destChainId, {
    portId: ics721Port(bridgeContract),
    checkCounterparty: true,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/* -------------------------------------------------------------------------- *
 * Messages
 * -------------------------------------------------------------------------- */

/** A same-chain CW721 `transfer_nft`. */
export function buildSameChainNftTransfer(input: {
  chainId: string;
  sender: string;
  collectionAddress: string;
  tokenId: string;
  recipient: string;
}): BuiltMsg {
  const chain = requireChain(input.chainId);
  return buildTransferNftMsg(chain, {
    sender: input.sender,
    collectionAddress: input.collectionAddress,
    tokenId: input.tokenId,
    recipient: input.recipient,
  });
}

/** What has to be true before an ICS721 transfer can be built. */
export interface Ics721Input {
  chainId: string;
  destChainId: string;
  sender: string;
  collectionAddress: string;
  tokenId: string;
  recipient: string;
  bridgeContract: string;
  channelId: string;
}

/** An ICS721 `send_nft` to the bridge, carrying the base64 `IbcOutgoingMsg`. */
export function buildCrossChainNftTransfer(input: Ics721Input): BuiltMsg {
  const chain = requireChain(input.chainId);
  const destChain = requireChain(input.destChainId);
  const request: NftTransferRequest = {
    chainId: input.chainId,
    destChainId: input.destChainId,
    collectionAddress: input.collectionAddress,
    tokenId: input.tokenId,
    sender: input.sender,
    recipient: input.recipient,
    channelId: input.channelId,
    bridgeContract: input.bridgeContract,
    timeoutMinutes: ICS721_TIMEOUT_MINUTES,
  };
  return buildIcs721TransferMsg(chain, request, { destChain });
}

/**
 * The sentences the user must read before signing a cross-chain transfer.
 *
 * The first is always the voucher warning: the destination chain does not
 * receive "the NFT", it mints a debt voucher backed by the original, which
 * stays escrowed in the bridge on this chain.
 */
export function crossChainWarnings(input: {
  chainId: string;
  destChainId: string;
  bridgeContract: string;
  channelId: string;
  collectionAddress: string;
  tokenId: string;
  sender: string;
  recipient: string;
}): readonly string[] {
  return ics721TransferWarnings({
    chainId: input.chainId,
    destChainId: input.destChainId,
    collectionAddress: input.collectionAddress,
    tokenId: input.tokenId,
    sender: input.sender,
    recipient: input.recipient,
    channelId: input.channelId,
    bridgeContract: input.bridgeContract,
    timeoutMinutes: ICS721_TIMEOUT_MINUTES,
  });
}

export { ICS721_VOUCHER_WARNING };

/* -------------------------------------------------------------------------- *
 * Decoding, for the approval screen
 * -------------------------------------------------------------------------- */

/**
 * What a `MsgExecuteContract` will do, when it is a CW721 transfer.
 *
 * The kernel's own preview says `Execute "transfer_nft" on juno1...`, which
 * names the action and nothing else: not which token, not which collection, not
 * who receives it. "Execute contract" is not informed consent for giving away a
 * one-of-a-kind asset, so the approval screen decodes the message itself and
 * this is the result it renders.
 */
export type NftExecuteAction =
  | {
      readonly kind: "transfer_nft";
      readonly collectionAddress: string;
      readonly tokenId: string;
      readonly recipient: string;
    }
  | {
      readonly kind: "send_nft";
      readonly collectionAddress: string;
      readonly tokenId: string;
      /** The contract receiving the token, which for ICS721 is the bridge. */
      readonly receivingContract: string;
      /** Parsed `IbcOutgoingMsg`, when the inner payload is one. */
      readonly ics721: {
        readonly receiver: string;
        readonly channelId: string;
        readonly timeoutNanos: string | null;
        readonly memo: string | null;
      } | null;
      /** The inner payload as JSON text, so an unrecognised one is still visible. */
      readonly innerJson: string;
    };

/** A decoded NFT execute, plus anything about it the user should be told. */
export interface NftExecuteDescription {
  readonly action: NftExecuteAction;
  /** Non-fatal notes, e.g. funds attached to a CW721 call, which takes none. */
  readonly warnings: readonly string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Decode a CW721 ExecuteMsg that has already been parsed into JSON.
 *
 * Split out from {@link describeNftExecute} because the same message reaches
 * this wallet two ways with two encodings: proto-JSON from the interchain
 * engine, where `msg` is base64, and Amino from a dApp's sign doc, where `msg`
 * is a plain object. Both have to produce the same sentence, or the wallet
 * describes its own transfers better than the ones a website asks for - which
 * is exactly backwards.
 *
 * @param contract - The CW721 contract the message executes against.
 * @param body - The parsed ExecuteMsg.
 * @param funds - The coins attached, if any. Any at all earns a warning.
 */
export function describeCw721Action(
  contract: string,
  body: unknown,
  funds?: unknown,
): NftExecuteDescription | null {
  const parsed = asRecord(body);
  if (!contract || !parsed) return null;

  const warnings: string[] = [];
  if (Array.isArray(funds) && funds.length > 0) {
    // CW721 execute messages take no funds. Coins on one are either a mistake
    // or a payload the wallet does not understand, and either way the user is
    // spending money they were not told about.
    warnings.push(
      "This message also sends coins. A CW721 transfer takes none, so check what you are approving.",
    );
  }

  const transfer = asRecord(parsed.transfer_nft);
  if (transfer) {
    const recipient = asString(transfer.recipient);
    const tokenId = asString(transfer.token_id);
    if (!recipient || !tokenId) return null;
    return {
      action: { kind: "transfer_nft", collectionAddress: contract, tokenId, recipient },
      warnings,
    };
  }

  const send = asRecord(parsed.send_nft);
  if (send) {
    const receivingContract = asString(send.contract);
    const tokenId = asString(send.token_id);
    const inner = send.msg;
    if (!receivingContract || !tokenId || typeof inner !== "string") return null;
    let innerValue: unknown;
    try {
      innerValue = JSON.parse(decodeBase64Utf8(inner)) as unknown;
    } catch {
      return null;
    }
    const outgoing = asRecord(innerValue);
    const receiver = outgoing ? asString(outgoing.receiver) : null;
    const channelId = outgoing ? asString(outgoing.channel_id) : null;
    const timeout = outgoing ? asRecord(outgoing.timeout) : null;
    return {
      action: {
        kind: "send_nft",
        collectionAddress: contract,
        tokenId,
        receivingContract,
        ics721:
          receiver && channelId
            ? {
                receiver,
                channelId,
                timeoutNanos: timeout ? asString(timeout.timestamp) : null,
                memo: outgoing ? asString(outgoing.memo) : null,
              }
            : null,
        innerJson: JSON.stringify(innerValue),
      },
      warnings,
    };
  }

  return null;
}

/**
 * Decode a built `MsgExecuteContract` into the NFT action it performs.
 *
 * Returns `null` for anything that is not a CW721 transfer this function can
 * read in full - a different type URL, a different ExecuteMsg, a missing field.
 * Null means "Zunia cannot say what this does", and the screen has to say that
 * rather than fall back to a guess; a partially-decoded transfer described as a
 * whole one is worse than no description.
 */
export function describeNftExecute(msg: BuiltMsg): NftExecuteDescription | null {
  if (msg.typeUrl !== "/cosmwasm.wasm.v1.MsgExecuteContract") return null;
  const contract = asString(msg.value["contract"]);
  const encoded = msg.value["msg"];
  if (!contract || typeof encoded !== "string") return null;
  let payload: unknown;
  try {
    payload = base64ToJson(encoded);
  } catch {
    return null;
  }
  return describeCw721Action(contract, payload, msg.value["funds"]);
}

/**
 * The action name a CosmWasm ExecuteMsg declares, e.g. `transfer_nft`.
 *
 * The top-level key of an ExecuteMsg is the action by convention, and naming it
 * turns "execute a contract" into "approve a transfer_nft" even when the rest
 * of the payload is not one this wallet models. `null` when the payload is not
 * an object with exactly one action-shaped key, because a guess there would be
 * a label with no basis.
 */
export function cosmWasmActionName(body: unknown): string | null {
  const parsed = asRecord(body);
  if (!parsed) return null;
  const keys = Object.keys(parsed);
  return keys.length === 1 ? (keys[0] ?? null) : null;
}

/** Re-exported so screens can render an arbitrary ExecuteMsg body if they must. */
export type { JsonObject, JsonValue, NftCollection, NftToken, ChainInfoLike };
