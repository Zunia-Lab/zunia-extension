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
  listOwnedTokenIds,
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
  NFT_SDK_MODULE_CHAINS,
  NFT_WASM_SCAN_MAX_CODES,
  NFT_WASM_SCAN_MAX_CONTRACTS,
  NFT_WASM_SCAN_MAX_CONTRACTS_PER_CODE,
  NFT_WASM_SCAN_TTL_MS,
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
import { getSettings } from "./settings";
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
  if (supportsCosmWasm(entry) || NFT_SDK_MODULE_CHAINS.includes(chainId)) {
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

/**
 * Ask the chain whether this address is a collection, before it is saved.
 * A passing test is `collection_info` (or the nft module class) answering.
 */
export async function probeUserContract(
  chainId: string,
  address: string,
): Promise<{ ok: true; name: string | null } | { ok: false; error: string }> {
  const entry = findCatalogEntry(chainId);
  if (!entry) return { ok: false, error: "That network is not in this wallet." };
  const trimmed = address.trim();
  if (!trimmed) return { ok: false, error: "Enter a contract address." };
  if (!trimmed.startsWith(`${entry.bech32Prefix}1`)) {
    return {
      ok: false,
      error: `Addresses on ${entry.chainName} start with ${entry.bech32Prefix}1.`,
    };
  }
  try {
    const info = await loadCollection(chainId, trimmed);
    return { ok: true, name: info.name?.trim() || null };
  } catch (error) {
    return { ok: false, error: describeInterchainError(error) };
  }
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
  readonly source: NftCollectionSource;
  readonly tokenIds: readonly string[];
  /** True when the per-contract cap cut the id list short. */
  readonly truncated: boolean;
  /** From `collection_info` / `contract_info`; null when the contract has none. */
  readonly info: NftCollection | null;
  /** Why `info` is null, when the collection read failed. Shown, never hidden. */
  readonly infoError: string | null;
}

/**
 * Where one collection came from.
 *
 * `module` is the Cosmos SDK `x/nft` module answering `nfts?owner=`, which is a
 * chain-level index of everything this address holds and is the only path that
 * can be complete without a third party. The engine's three sources - a shipped
 * list, a chain indexer, the user's own address - cannot express that, so it is
 * added here rather than mislabelled as "indexed".
 */
export type NftCollectionSource = NftDiscoverySource | "module";

/**
 * Which discovery paths actually ran, so the UI can never imply it looked
 * everywhere.
 *
 * This is the piece the mobile app got wrong: it rendered "you own no NFTs"
 * after querying nothing at all. Every number here is something that was really
 * asked, and each is reported separately because they are different facts with
 * different fixes: an `x/nft` chain that answered needs nothing from the user,
 * while a CosmWasm chain whose codes are all non-CW721 needs a pasted address.
 */
export interface NftScanReport {
  /** True when `x/nft` answered. False on the chains that do not run it. */
  readonly moduleAnswered: boolean;
  /** Classes `x/nft` named for this owner. */
  readonly moduleClasses: number;
  /** False when the module answered but paging stopped before the end. */
  readonly moduleComplete: boolean;
  /** Wasm codes whose query interface is known, from this run or a past one. */
  readonly codesScanned: number;
  /** Codes the chain says it has in total. `null` when it did not say. */
  readonly codesTotal: number | null;
  /** Of {@link codesScanned}, how many answer the CW721 `tokens` query. */
  readonly cw721Codes: number;
  /**
   * CW721 contracts in this run's list, every one of which is asked `tokens`
   * unless the engine's per-run cap cut the list short.
   */
  readonly cw721Probed: number;
  /**
   * Contracts that answered "I do not implement that query".
   *
   * Counted rather than listed. A contract rejecting `tokens` is not a failure
   * the user can act on - it means the address is not a CW721 collection - and
   * fifty of those rendered as errors is the defect this field exists to stop.
   */
  readonly notCw721: number;
  /** Why the chain-wide CW721 scan did not run, or `null` when it did. */
  readonly scanSkipped: NftScanSkip | null;
  /** True when the CW721 contract list was reused from the stored scan. */
  readonly fromCache: boolean;
  /** Contracts from `config/nft.ts` for this chain. */
  readonly known: number;
  /** Contracts the user added for this chain. */
  readonly user: number;
  /** Indexer name when one answered, else `null`. */
  readonly indexer: string | null;
  /** True when the chain's own `x/nft` or wasm code list was asked. */
  readonly onChain: boolean;
  /** True when no contract and no indexer was consulted: nothing was queried. */
  readonly queriedNothing: boolean;
}

/** What one discovery run found and what it cannot promise. */
export interface NftListResult {
  readonly chainId: string;
  readonly owner: string;
  readonly collections: readonly NftCollectionView[];
  readonly sources: readonly NftCollectionSource[];
  /** True only when an indexer answered cleanly. Never true for a contract scan. */
  readonly complete: boolean;
  /** The engine's sentence about why a scan can never be complete. */
  readonly limitation: string | null;
  /**
   * Lookups that failed in a way the user can act on.
   *
   * A contract saying "not a CW721" is not one of these; it is counted in
   * `scan.notCw721`. What lands here is a node that would not answer, an
   * indexer that errored, or the live-reads gate refusing the read.
   */
  readonly issues: readonly NftDiscoveryIssue[];
  readonly scan: NftScanReport;
}

/**
 * Find the collections an address holds tokens in, on one chain.
 *
 * Three paths, tried in order of how much they can promise:
 *
 * 1. `x/nft`, the Cosmos SDK module. One request, complete for the chains that
 *    run it, and unambiguous because the chain itself keeps the owner index.
 * 2. a chain indexer, when the host configured one for this chain.
 * 3. CW721 contracts - shipped, scanned off the chain's own wasm code list, and
 *    the ones the user pasted. Never complete, and said so.
 *
 * {@link NftScanReport} says which of them ran. A run that consulted nothing at
 * all is reported as such: an empty grid under "we asked nobody" is a different
 * screen from an empty grid under "we asked and you hold none", and conflating
 * them is how a wallet tells its user they own nothing when it never looked.
 */
export async function discoverCollections(
  chainId: string,
  owner: string,
  options: { signal?: AbortSignal; force?: boolean } = {},
): Promise<NftListResult> {
  const entry = requireChain(chainId);
  const wasm = supportsCosmWasm(entry);
  const knownContracts = NFT_KNOWN_CONTRACTS[chainId] ?? [];
  const userContracts = await listUserContracts(chainId);
  const hostedIndexer = NFT_INDEXERS[chainId];
  const autoScan = (await getSettings()).nftAutoScan;
  const signal = options.signal;

  const module_ = await listSdkOwnerNfts(chainId, owner, signal);

  // The wasm scan is the expensive path, so it is skipped whenever something
  // better already covers the chain. Each reason is reported, because "we did
  // not scan" and "we scanned and found nothing" are different answers.
  const scanSkipped: NftScanSkip | null = !wasm
    ? "no-cosmwasm"
    : hostedIndexer
      ? "indexer"
      : !autoScan
        ? "preference"
        : null;
  const scan =
    scanSkipped === null
      ? await scanCw721Contracts(chainId, owner, {
          ...(signal ? { signal } : {}),
          force: options.force === true,
        })
      : NO_CW721_SCAN;

  const holdings = new Map<
    string,
    { source: NftCollectionSource; tokenIds: string[]; truncated: boolean }
  >();
  const issues: NftDiscoveryIssue[] = [...module_.issues, ...scan.issues];
  const sources = new Set<NftCollectionSource>();
  let notCw721 = 0;

  for (const [classId, tokenIds] of module_.byClass) {
    holdings.set(classId, { source: "module", tokenIds, truncated: false });
    sources.add("module");
  }

  const scanned = new Set(scan.addresses);
  let cw721Probed = 0;

  if (wasm) {
    const ctx = contextFor(chainId);
    const candidates = [...knownContracts, ...scan.addresses];
    const result = await discoverNfts(ctx, owner, {
      knownContracts: candidates,
      userContracts,
      ...(hostedIndexer ? { indexer: hostedIndexer } : {}),
      maxContracts: Math.max(NFT_MAX_CONTRACTS, scan.addresses.length),
      maxTokensPerContract: NFT_MAX_TOKENS_PER_CONTRACT,
      ...(signal ? { signal } : {}),
    });
    cw721Probed = new Set([...candidates, ...userContracts]).size;
    for (const issue of result.issues) {
      // A scanned address that rejects a CW721 query is not a failure: it is
      // the answer "this is not a collection". Counted, not shown.
      if (
        issue.contractAddress !== null &&
        scanned.has(issue.contractAddress) &&
        !userContracts.includes(issue.contractAddress) &&
        isNotCw721Message(issue.message)
      ) {
        notCw721 += 1;
        continue;
      }
      issues.push(issue);
    }
    for (const source of result.sources) sources.add(source);
    for (const holding of result.holdings) {
      const existing = holdings.get(holding.contractAddress);
      if (existing) {
        const seen = new Set(existing.tokenIds);
        for (const id of holding.tokenIds) {
          if (!seen.has(id)) existing.tokenIds.push(id);
        }
        existing.truncated = existing.truncated || holding.truncated;
        continue;
      }
      holdings.set(holding.contractAddress, {
        source: holding.source,
        tokenIds: [...holding.tokenIds],
        truncated: holding.truncated,
      });
    }
  }

  const collections: NftCollectionView[] = [];
  for (const [contractAddress, holding] of holdings) {
    const meta = await readCollectionMeta(
      chainId,
      contractAddress,
      wasm && holding.source !== "module",
      signal,
    );
    collections.push({
      contractAddress,
      source: holding.source,
      tokenIds: holding.tokenIds,
      truncated: holding.truncated,
      info: meta.info,
      infoError: meta.infoError,
    });
  }

  const indexerAnswered = hostedIndexer !== undefined && sources.has("indexer");
  const onChainAsked = module_.answered || scan.codesScanned > 0;
  // "Nothing was queried" has to mean exactly that. A scan that classified wasm
  // codes and found no CW721 among them did query - it learned something - and
  // must not be reported as a screen that never looked.
  const queriedNothing =
    !onChainAsked &&
    !indexerAnswered &&
    knownContracts.length === 0 &&
    userContracts.length === 0;

  return {
    chainId,
    owner,
    collections,
    sources: [...sources],
    complete: indexerAnswered && issues.length === 0,
    limitation:
      indexerAnswered || queriedNothing ? null : NFT_DISCOVERY_LIMITATION,
    issues,
    scan: {
      moduleAnswered: module_.answered,
      moduleClasses: module_.byClass.size,
      moduleComplete: module_.complete,
      codesScanned: scan.codesScanned,
      codesTotal: scan.codesTotal,
      cw721Codes: scan.cw721Codes,
      cw721Probed,
      notCw721,
      scanSkipped,
      fromCache: scan.fromCache,
      known: knownContracts.length + scan.addresses.length,
      user: userContracts.length,
      indexer: indexerAnswered ? (hostedIndexer?.name ?? null) : null,
      onChain: onChainAsked,
      queriedNothing,
    },
  };
}

async function readCollectionMeta(
  chainId: string,
  contractAddress: string,
  wasm: boolean,
  signal?: AbortSignal,
): Promise<{ info: NftCollection | null; infoError: string | null }> {
  if (wasm) {
    try {
      return {
        info: await getCollectionInfo(contextFor(chainId), contractAddress, {
          ...(signal ? { signal } : {}),
        }),
        infoError: null,
      };
    } catch (error) {
      if (isInterchainError(error) && error.code === "aborted") throw error;
    }
  }
  const sdk = await loadSdkNftClass(chainId, contractAddress, signal);
  if (sdk.info) return sdk;
  return {
    info: null,
    infoError: wasm
      ? "Collection details could not be read from the contract or the nft module."
      : sdk.infoError,
  };
}

function isModuleMissing(error: unknown): boolean {
  if (!isInterchainError(error)) return false;
  // Gateways with no x/nft registered answer 400, 404, or 501. A 400 here is
  // "this query is not served", not a request we built wrong: the path is fixed.
  if (error.httpStatus === 400 || error.httpStatus === 404 || error.httpStatus === 501) {
    return true;
  }
  return /not found|unknown query|no handler|not implemented|module.*not found/i.test(
    error.message,
  );
}

async function lcdGet(
  chainId: string,
  path: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const chain = chainRegistry().get(chainId);
  if (!chain) {
    throw new InterchainError(
      "unsupported-chain",
      `${chainId} is not in this wallet's chain list`,
      { chainId },
    );
  }
  return lcdFor(chain).getJson(path, {
    cacheTtlMs: 0,
    ...(signal ? { signal } : {}),
  });
}

/* -------------------------------------------------------------------------- *
 * The Cosmos SDK nft module
 * -------------------------------------------------------------------------- */

/** What `safrochaind query nft nfts --owner` had to say. */
interface SdkOwnerNfts {
  /** True only when the module really answered. False when it is not there. */
  readonly answered: boolean;
  /** False when paging stopped early, so the class list may be short. */
  readonly complete: boolean;
  readonly byClass: Map<string, string[]>;
  readonly issues: NftDiscoveryIssue[];
}

/** Rows per page of `/cosmos/nft/v1beta1/nfts`. */
const SDK_NFT_PAGE_LIMIT = 100;

/**
 * Pages read before the walk stops.
 *
 * `next_key` is node-controlled, so a budget is the only thing standing between
 * a misbehaving node and an endless loop in a popup. Stopping early sets
 * `complete: false` rather than quietly returning a short list.
 */
const SDK_NFT_MAX_PAGES = 10;

/** The `pagination.next_key` of a Cosmos SDK list response, when there is one. */
function nextPageKey(body: unknown): string | null {
  const page = asPlainRecord(asPlainRecord(body)?.pagination);
  const key = page?.next_key ?? page?.nextKey;
  return typeof key === "string" && key.length > 0 ? key : null;
}

/**
 * Every class this owner holds a token in, from `x/nft`.
 *
 * Paged to the end, because the sentence the screen shows about this path -
 * "the chain's own index answered, so these are all of them" - is only true if
 * every page was read. A first page taken for the whole answer is the quiet
 * kind of wrong: it looks like a complete list and is not one.
 */
async function listSdkOwnerNfts(
  chainId: string,
  owner: string,
  signal?: AbortSignal,
): Promise<SdkOwnerNfts> {
  const byClass = new Map<string, string[]>();
  const issues: NftDiscoveryIssue[] = [];
  let key: string | null = null;

  for (let page = 0; page < SDK_NFT_MAX_PAGES; page++) {
    const params = new URLSearchParams({
      owner,
      "pagination.limit": String(SDK_NFT_PAGE_LIMIT),
    });
    if (key !== null) params.set("pagination.key", key);
    try {
      const body = await lcdGet(
        chainId,
        `/cosmos/nft/v1beta1/nfts?${params.toString()}`,
        signal,
      );
      collectSdkNfts(body, byClass);
      key = nextPageKey(body);
      if (key === null) return { answered: true, complete: true, byClass, issues };
    } catch (error) {
      if (isInterchainError(error) && error.code === "aborted") throw error;
      // No nft module on this chain. Not a failure and not worth a word to the
      // user: most Cosmos chains do not run it.
      if (isModuleMissing(error)) {
        return { answered: false, complete: true, byClass, issues };
      }
      issues.push({
        contractAddress: null,
        message: `nft module: ${describeInterchainError(error)}`,
      });
      return { answered: page > 0, complete: false, byClass, issues };
    }
  }
  return { answered: true, complete: false, byClass, issues };
}

function collectSdkNfts(body: unknown, into: Map<string, string[]>): void {
  const root = asPlainRecord(body);
  const rows = Array.isArray(root?.nfts) ? root.nfts : [];
  for (const row of rows) {
    const item = asPlainRecord(row);
    const classId =
      (typeof item?.class_id === "string" && item.class_id) ||
      (typeof item?.classId === "string" && item.classId) ||
      "";
    const id =
      (typeof item?.id === "string" && item.id) ||
      (typeof item?.token_id === "string" && item.token_id) ||
      "";
    if (!classId || !id) continue;
    const current = into.get(classId) ?? [];
    if (!current.includes(id)) current.push(id);
    into.set(classId, current);
  }
}

/* -------------------------------------------------------------------------- *
 * The CW721 code scan
 * -------------------------------------------------------------------------- */

/** Why the chain-wide CW721 scan did not run. */
export type NftScanSkip = "no-cosmwasm" | "indexer" | "preference";

/** Whether a wasm code answers the CW721 `tokens` query. */
type CodeKind = "cw721" | "other";

/** One chain's half of `STORAGE_KEYS.nftWasmScan`. */
interface WasmScanRecord {
  /** code id → verdict. Permanent: wasm code is immutable. */
  readonly codes: Record<string, CodeKind>;
  /** CW721 contract addresses the last completed scan found. */
  readonly contracts: readonly string[];
  /** When `contracts` was built. 0 when no scan has completed. */
  readonly contractsAt: number;
  /** `pagination.total` of the code list, when the node reported it. */
  readonly codesTotal: number | null;
}

/** What one scan of a chain's wasm codes produced. */
interface Cw721Scan {
  readonly addresses: readonly string[];
  readonly codesScanned: number;
  readonly cw721Codes: number;
  readonly codesTotal: number | null;
  readonly fromCache: boolean;
  readonly issues: readonly NftDiscoveryIssue[];
}

/** The report for a scan that was deliberately not run. */
const NO_CW721_SCAN: Cw721Scan = {
  addresses: [],
  codesScanned: 0,
  cw721Codes: 0,
  codesTotal: null,
  fromCache: false,
  issues: [],
};

const EMPTY_SCAN_RECORD: WasmScanRecord = {
  codes: {},
  contracts: [],
  contractsAt: 0,
  codesTotal: null,
};

/** Bumped when the record shape changes, which discards every stored verdict. */
const WASM_SCAN_VERSION = 1;

function asScanRecord(value: unknown): WasmScanRecord {
  const row = asPlainRecord(value);
  if (!row) return EMPTY_SCAN_RECORD;
  const codes: Record<string, CodeKind> = {};
  for (const [codeId, kind] of Object.entries(asPlainRecord(row.codes) ?? {})) {
    if (kind === "cw721" || kind === "other") codes[codeId] = kind;
  }
  const contracts = Array.isArray(row.contracts)
    ? row.contracts.filter((v): v is string => typeof v === "string" && v.length > 0)
    : [];
  return {
    codes,
    contracts,
    contractsAt: typeof row.contractsAt === "number" ? row.contractsAt : 0,
    codesTotal: typeof row.codesTotal === "number" ? row.codesTotal : null,
  };
}

async function readScanStore(): Promise<Record<string, unknown>> {
  const raw = (await browser.storage.local.get(STORAGE_KEYS.nftWasmScan))[
    STORAGE_KEYS.nftWasmScan
  ];
  const row = asPlainRecord(raw);
  if (!row || row.version !== WASM_SCAN_VERSION) return {};
  return asPlainRecord(row.chains) ?? {};
}

async function readWasmScan(chainId: string): Promise<WasmScanRecord> {
  try {
    return asScanRecord((await readScanStore())[chainId]);
  } catch {
    // A scan cache that cannot be read is a slow screen, never a broken one.
    return EMPTY_SCAN_RECORD;
  }
}

/**
 * Serialised writes to the scan cache.
 *
 * Every enabled chain scans in parallel and they all write one storage key, so
 * an unguarded read-modify-write loses whichever verdicts finished first - and
 * losing them means re-probing forty wasm codes on the next open.
 */
let scanWrites: Promise<unknown> = Promise.resolve();

async function writeWasmScan(chainId: string, record: WasmScanRecord): Promise<void> {
  const run = async () => {
    try {
      const chains = await readScanStore();
      await browser.storage.local.set({
        [STORAGE_KEYS.nftWasmScan]: {
          version: WASM_SCAN_VERSION,
          chains: { ...chains, [chainId]: record },
        },
      });
    } catch {
      // Storage is a cache here. Failing to write it costs requests, not truth.
    }
  };
  const next = scanWrites.then(run, run);
  scanWrites = next;
  return next;
}

/** Forget every stored verdict, so the next run re-classifies from scratch. */
export async function clearNftScanCache(): Promise<void> {
  await browser.storage.local.remove(STORAGE_KEYS.nftWasmScan);
}

/**
 * True when a failure means "this contract does not implement that query".
 *
 * wasmd answers a query a contract cannot parse with HTTP 400 carrying the
 * serde error, which the engine reclassifies as `contract-error`. That is an
 * answer, not an outage: the contract is not a CW721. A cancelled read and a
 * refused-by-preference read are neither, and must never be read as one.
 */
function isNotCw721(error: unknown): boolean {
  if (!isInterchainError(error)) return false;
  if (error.code === "aborted" || error.code === "reads-disabled") return false;
  if (error.code === "contract-error" || error.code === "malformed-response") {
    return true;
  }
  return error.httpStatus === 400;
}

/** The same verdict, read off the message the engine put in an issue. */
function isNotCw721Message(message: string): boolean {
  return /^(contract-error|malformed-response):/.test(message);
}

/** One page of `/cosmwasm/wasm/v1/code/{id}/contracts`. */
async function listCodeContracts(
  chainId: string,
  codeId: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const body = await lcdGet(
    chainId,
    `/cosmwasm/wasm/v1/code/${encodeURIComponent(codeId)}/contracts` +
      `?pagination.limit=${NFT_WASM_SCAN_MAX_CONTRACTS_PER_CODE}&pagination.reverse=true`,
    signal,
  );
  const rows = asPlainRecord(body)?.contracts;
  return Array.isArray(rows)
    ? rows.filter((v): v is string => typeof v === "string" && v.length > 0)
    : [];
}

/**
 * Wasm code ids, newest first, with the chain's total when it reports one.
 *
 * `pagination.reverse` and `pagination.count_total` are standard `PageRequest`
 * fields, but a node behind a trimming proxy can still reject them, so a
 * rejection is retried once with neither. Losing "newest first" degrades the
 * scan; failing the whole screen over a query string would not be a trade.
 */
async function listWasmCodeIds(
  chainId: string,
  signal?: AbortSignal,
): Promise<{ ids: string[]; total: number | null }> {
  const base = `/cosmwasm/wasm/v1/code?pagination.limit=${NFT_WASM_SCAN_MAX_CODES}`;
  let body: unknown;
  try {
    body = await lcdGet(
      chainId,
      `${base}&pagination.reverse=true&pagination.count_total=true`,
      signal,
    );
  } catch (error) {
    if (isInterchainError(error) && error.code === "aborted") throw error;
    if (isInterchainError(error) && error.code === "reads-disabled") throw error;
    body = await lcdGet(chainId, base, signal);
  }
  const root = asPlainRecord(body);
  const rows = Array.isArray(root?.code_infos) ? root.code_infos : [];
  const ids: string[] = [];
  for (const row of rows) {
    const info = asPlainRecord(row);
    const codeId = String(info?.code_id ?? info?.id ?? "");
    if (!codeId || codeId === "undefined" || ids.includes(codeId)) continue;
    ids.push(codeId);
  }
  const total = Number(asPlainRecord(root?.pagination)?.total ?? NaN);
  return { ids, total: Number.isFinite(total) && total > 0 ? total : null };
}

/**
 * Decide whether a wasm code is a CW721 by asking one of its instances.
 *
 * The probe is the exact `tokens` query discovery will send, so a code that
 * passes costs nothing extra - the LCD client serves the real read from its
 * response cache - and a code that fails is never asked again for any of its
 * instances. Two instances are tried before giving up, so one dead contract
 * cannot condemn a whole collection's code.
 *
 * Returns `null` when the node would not answer either way: a verdict must not
 * be cached from an outage, because the cache is permanent.
 */
async function classifyCode(
  ctx: NftChainContext,
  contracts: readonly string[],
  owner: string,
  signal?: AbortSignal,
): Promise<CodeKind | null> {
  for (const address of contracts.slice(0, 2)) {
    try {
      await listOwnedTokenIds(ctx, address, owner, {
        ...(signal ? { signal } : {}),
      });
      return "cw721";
    } catch (error) {
      if (isInterchainError(error) && error.code === "aborted") throw error;
      if (isInterchainError(error) && error.code === "reads-disabled") throw error;
      if (isNotCw721(error)) return "other";
    }
  }
  return null;
}

/**
 * The CW721 contracts on a chain, found from the chain's own wasm code list.
 *
 * This is what replaced probing every contract the chain has ever instantiated.
 * That version sent a `tokens` query to pools, multisigs, hooks and fee
 * splitters, and rendered each HTTP 400 as a failure the user was asked to do
 * something about - fifty red lines on Osmosis saying nothing except that
 * Osmosis runs contracts which are not NFT collections.
 *
 * Contracts of one code all run the same bytecode, so the question "does this
 * answer `tokens`?" is a question about the code, not the contract. Asking it
 * once per code turns fifty wrong answers into forty right ones, and because
 * wasm code is immutable the answer is cached for good: later runs list
 * instances only for the codes that turned out to be collections.
 */
async function scanCw721Contracts(
  chainId: string,
  owner: string,
  options: { signal?: AbortSignal; force?: boolean },
): Promise<Cw721Scan> {
  const stored = await readWasmScan(chainId);
  const cached = Object.keys(stored.codes);
  if (
    options.force !== true &&
    stored.contractsAt > 0 &&
    Date.now() - stored.contractsAt < NFT_WASM_SCAN_TTL_MS
  ) {
    return {
      addresses: stored.contracts,
      codesScanned: cached.length,
      cw721Codes: cached.filter((id) => stored.codes[id] === "cw721").length,
      codesTotal: stored.codesTotal,
      fromCache: true,
      issues: [],
    };
  }

  const signal = options.signal;
  const issues: NftDiscoveryIssue[] = [];
  const codes: Record<string, CodeKind> = { ...stored.codes };
  const addresses: string[] = [];
  let codesTotal = stored.codesTotal;
  let cw721Codes = 0;
  let scanned = 0;

  try {
    const ctx = contextFor(chainId);
    const listed = await listWasmCodeIds(chainId, signal);
    codesTotal = listed.total ?? codesTotal;

    for (const codeId of listed.ids) {
      if (addresses.length >= NFT_WASM_SCAN_MAX_CONTRACTS) break;
      // A code already known not to be a CW721 costs nothing: its instances are
      // never listed and never asked.
      if (codes[codeId] === "other") {
        scanned += 1;
        continue;
      }
      let instances: string[] = [];
      try {
        instances = await listCodeContracts(chainId, codeId, signal);
      } catch (error) {
        if (isInterchainError(error) && error.code === "aborted") throw error;
        if (isInterchainError(error) && error.code === "reads-disabled") throw error;
        continue;
      }
      if (instances.length === 0) continue;

      const verdict =
        codes[codeId] ?? (await classifyCode(ctx, instances, owner, signal));
      if (verdict === null) continue;
      codes[codeId] = verdict;
      scanned += 1;
      if (verdict !== "cw721") continue;
      cw721Codes += 1;
      for (const address of instances) {
        if (addresses.includes(address)) continue;
        addresses.push(address);
        if (addresses.length >= NFT_WASM_SCAN_MAX_CONTRACTS) break;
      }
    }

    await writeWasmScan(chainId, {
      codes,
      contracts: addresses,
      contractsAt: Date.now(),
      codesTotal,
    });
    return {
      addresses,
      codesScanned: scanned,
      cw721Codes,
      codesTotal,
      fromCache: false,
      issues,
    };
  } catch (error) {
    if (isInterchainError(error) && error.code === "aborted") throw error;
    // No wasm module, or a node that will not list codes. Neither is something
    // the user can fix by reading a stack of contract addresses, so the scan
    // reports what it managed and the screen says a scan did not complete.
    if (!isModuleMissing(error)) {
      issues.push({
        contractAddress: null,
        message: `wasm codes: ${describeInterchainError(error)}`,
      });
    }
    return {
      addresses,
      codesScanned: scanned,
      cw721Codes,
      codesTotal,
      fromCache: false,
      issues,
    };
  }
}

async function loadSdkNftClass(
  chainId: string,
  classId: string,
  signal?: AbortSignal,
): Promise<{ info: NftCollection | null; infoError: string | null }> {
  try {
    const body = await lcdGet(
      chainId,
      `/cosmos/nft/v1beta1/classes/${encodeURIComponent(classId)}`,
      signal,
    );
    const root = asPlainRecord(body);
    const row = asPlainRecord(root?.class) ?? root;
    if (!row) return { info: null, infoError: "Class response was empty." };
    return {
      info: {
        chainId,
        contractAddress: classId,
        name: typeof row.name === "string" ? row.name : null,
        symbol: typeof row.symbol === "string" ? row.symbol : null,
        description: typeof row.description === "string" ? row.description : null,
        imageUri: typeof row.uri === "string" ? row.uri : null,
        tokenCount: null,
        creator: null,
      },
      infoError: null,
    };
  } catch (error) {
    if (isInterchainError(error) && error.code === "aborted") throw error;
    return {
      info: null,
      infoError: isModuleMissing(error) ? null : describeInterchainError(error),
    };
  }
}

async function loadSdkNftToken(
  chainId: string,
  classId: string,
  tokenId: string,
  options: { collectionName?: string | null; signal?: AbortSignal } = {},
): Promise<NftTokenView> {
  const body = await lcdGet(
    chainId,
    `/cosmos/nft/v1beta1/nfts/${encodeURIComponent(classId)}/${encodeURIComponent(tokenId)}`,
    options.signal,
  );
  const root = asPlainRecord(body);
  const row = asPlainRecord(root?.nft) ?? root;
  const uri = typeof row?.uri === "string" ? row.uri : null;
  return {
    token: {
      tokenId,
      name: options.collectionName ? `${options.collectionName} #${tokenId}` : `#${tokenId}`,
      description: null,
      imageUri: uri,
      animationUri: null,
      attributes: [],
      collectionAddress: classId,
      chainId,
      owner: null,
      tokenUri: uri,
    },
    collectionName: options.collectionName ?? null,
    metadataSource: uri ? "chain" : "none",
    metadataError: null,
  };
}

function asPlainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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
  const entry = requireChain(chainId);
  if (supportsCosmWasm(entry)) {
    try {
      return await getCollectionInfo(contextFor(chainId), contractAddress, {
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      if (isInterchainError(error) && error.code === "aborted") throw error;
    }
  }
  const sdk = await loadSdkNftClass(chainId, contractAddress, options.signal);
  if (sdk.info) return sdk.info;
  throw new InterchainError(
    "contract-error",
    sdk.infoError ?? `No collection at ${contractAddress} on ${entry.chainName}.`,
    { chainId },
  );
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
  const entry = requireChain(chainId);
  let base: NftToken;
  try {
    if (!supportsCosmWasm(entry)) throw new Error("no-cosmwasm");
    const ctx = contextFor(chainId);
    base = await getNftToken(ctx, contractAddress, tokenId, {
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (isInterchainError(error) && error.code === "aborted") throw error;
    return loadSdkNftToken(chainId, contractAddress, tokenId, {
      collectionName: options.collectionName ?? null,
      signal: options.signal,
    });
  }
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

/**
 * The cw-ics721 bridges this wallet knows on a chain: the shipped one, and the
 * one the user pinned. A signing prompt reads a site's `send_nft` as a bridge
 * transfer only when it goes to one of these, since any contract can be handed
 * an NFT with a message shaped like an `IbcOutgoingMsg` and only a bridge acts
 * on it. Never throws: when storage cannot be read, the shipped one alone.
 */
export async function knownNftBridges(chainId: string): Promise<ReadonlySet<string>> {
  const known = new Set<string>();
  const shipped = ICS721_BRIDGE_CONTRACTS[chainId];
  if (shipped) known.add(shipped);
  try {
    const inForce = await nftBridgeAddress(chainId);
    if (inForce) known.add(inForce);
  } catch {
    // Unreadable storage knows no pin: fewer known bridges is the safe side.
  }
  return known;
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
      /**
       * Parsed `IbcOutgoingMsg`, when the receiving contract is a known bridge
       * and the inner payload is one. Any other contract holds the token
       * itself, whatever the payload says.
       */
      readonly ics721: {
        readonly receiver: string;
        readonly channelId: string;
        readonly timeoutNanos: string | null;
        readonly memo: string | null;
      } | null;
      /** The inner payload as JSON text, so an unrecognised one is still visible. */
      readonly innerJson: string;
    };

/** No known bridge: what a caller that names none gets, so it fails closed. */
const NO_BRIDGES: ReadonlySet<string> = new Set();

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
 * @param bridges - The cw-ics721 bridges known on the collection's chain
 *   ({@link knownNftBridges}). A `send_nft` is read as a bridge transfer only
 *   when it goes to one of them; to any other contract it is a hand-over to
 *   that contract, whatever its payload says, and `ics721` stays null.
 */
export function describeCw721Action(
  contract: string,
  body: unknown,
  funds?: unknown,
  bridges: ReadonlySet<string> = NO_BRIDGES,
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
    // Only a bridge turns the payload into a packet. Read from any other
    // contract's, a receiver and a channel would say where the NFT goes while
    // the contract itself keeps it.
    const outgoing = bridges.has(receivingContract) ? asRecord(innerValue) : null;
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
 * whole one is worse than no description. `bridges` as for
 * {@link describeCw721Action}: for the wallet's own cross-chain transfer, the
 * bridge it checked and built the message for.
 */
export function describeNftExecute(
  msg: BuiltMsg,
  bridges: ReadonlySet<string> = NO_BRIDGES,
): NftExecuteDescription | null {
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
  return describeCw721Action(contract, payload, msg.value["funds"], bridges);
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
