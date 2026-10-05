/**
 * The extension's single wiring of `@zunialab/interchain`.
 *
 * Every chain-facing read in this wallet (channel discovery, denom traces,
 * route planning, swap quoting, packet tracking) goes through the engine, and
 * the engine only ever sees the ports declared here. There is deliberately no
 * second implementation: `lib/ibc-channels.ts` used to hold a hand-rolled copy
 * of channel discovery and was deleted when this file replaced it. The one
 * read the engine does not offer yet, a channel's light-client status, lives
 * here (`readChannelClient`) until it does.
 *
 * Two things are the host's job and are done here:
 *
 * 1. The privacy gate. `readsAllowed` is handed to every LCD client, so a read
 *    attempted while live balances are off throws `reads-disabled` rather than
 *    silently returning nothing. The UI turns that code into a prompt.
 * 2. Deployment data. The crosschain-swaps contract address is host config
 *    (`config/interchain.ts`), is checked against the chain before any swap
 *    control is enabled, and fails closed with a named reason otherwise.
 *
 * This module runs in both the popup and the background worker. It touches
 * `fetch`, `browser.storage.local` and `browser.permissions` and nothing else,
 * so it never needs the mnemonic and never signs.
 */

import {
  createChainRegistry,
  createDenomResolver,
  createIbcChannelService,
  createLcdClient,
  createLcdResolver,
  deserializeRouteRegistry,
  lcdEndpointsFromChain,
  InterchainError,
  isInterchainError,
  SEED_CHANNEL_ROUTES,
  type ChainInfoLike,
  type ChainRegistryHandle,
  type ChannelRoute,
  type DenomResolver,
  type IbcChannelService,
  type LcdClient,
  type LcdClientFactory,
  type LcdClientHandle,
  type LcdResolver,
  type RouteRegistry,
  type RouteRegistrySnapshot,
  type SwapVenue,
} from "@zunialab/interchain";

import {
  MODULE_SUPPORT_PINS,
  SWAP_ROUTER_ENDPOINTS,
  SWAP_VENUE_CHAIN_ID,
  XCS_CONTRACT_CANDIDATES,
} from "../config/interchain";
import { hasLiveBalancePermission } from "./balances";
import {
  allCatalogEntries,
  findCatalogEntry,
  getCustomCatalogEntries,
  type CatalogEntry,
} from "./chain-catalog";
import { IBC_CHANNEL_ROWS } from "./ibc-channels.generated";
import { getSettings } from "./settings";
import { STORAGE_KEYS } from "./storage-keys";

/* -------------------------------------------------------------------------- *
 * The privacy gate
 * -------------------------------------------------------------------------- */

/**
 * Whether the wallet may read chain state right now.
 *
 * Both halves must hold: the user's `liveBalances` preference and the optional
 * host permission they granted for it. The answer is cached for a second
 * because the LCD client asks once per request and `browser.permissions`
 * round-trips to the browser process.
 */
let readsCache: { at: number; allowed: boolean } | null = null;
const READS_CACHE_MS = 1_000;

export async function interchainReadsAllowed(): Promise<boolean> {
  const now = Date.now();
  if (readsCache && now - readsCache.at < READS_CACHE_MS) return readsCache.allowed;
  const settings = await getSettings();
  const allowed = settings.liveBalances && (await hasLiveBalancePermission());
  readsCache = { at: now, allowed };
  return allowed;
}

/** Drop the cached gate answer. Call after the user changes the setting. */
export function clearReadsGateCache(): void {
  readsCache = null;
}

/** The copy the user sees when a read was refused by the gate rather than the network. */
export const READS_DISABLED_MESSAGE =
  "Turn on live balances in Preferences so Zunia can read chain state.";

/* -------------------------------------------------------------------------- *
 * Chain registry
 * -------------------------------------------------------------------------- */

/**
 * `CatalogEntry` is a structural subset of `ChainInfoLike`, so catalog rows go
 * straight in. The one field the engine wants and the generator drops is
 * `features`, which is why `featureSupport()` answers `unknown` for almost
 * every chain and the NFT/swap gates word themselves as "not confirmed".
 */
function toChainInfo(entry: CatalogEntry): ChainInfoLike {
  return entry;
}

let registryCache: {
  custom: readonly CatalogEntry[];
  handle: ChainRegistryHandle;
} | null = null;

/**
 * Chain lookup over the generated catalog plus anything the user added.
 *
 * Rebuilt when the custom-chain list changes identity, which `custom-chains.ts`
 * does on every hydrate, so a chain added in one context is visible in the next
 * lookup rather than after a reload.
 */
export function chainRegistry(): ChainRegistryHandle {
  const custom = getCustomCatalogEntries();
  if (registryCache && registryCache.custom === custom) return registryCache.handle;
  const handle = createChainRegistry(allCatalogEntries().map(toChainInfo));
  registryCache = { custom, handle };
  return handle;
}

/* -------------------------------------------------------------------------- *
 * LCD access
 * -------------------------------------------------------------------------- */

const clients = new Map<string, LcdClientHandle>();

/**
 * Read client for one chain, memoised so its response cache survives between
 * screens. A chain with no REST endpoint throws `unsupported-chain` rather than
 * producing a client that fails on first use.
 */
export function lcdFor(chain: ChainInfoLike): LcdClientHandle {
  const existing = clients.get(chain.chainId);
  if (existing) return existing;
  const endpoints = lcdEndpointsFromChain(chain);
  if (endpoints.length === 0) {
    throw new InterchainError(
      "unsupported-chain",
      `No REST endpoint configured for ${chain.chainId}`,
      { chainId: chain.chainId },
    );
  }
  const client = createLcdClient({
    chainId: chain.chainId,
    endpoints,
    timeoutMs: 9_000,
    retries: 1,
    cacheTtlMs: 15_000,
    readsAllowed: interchainReadsAllowed,
  });
  clients.set(chain.chainId, client);
  return client;
}

/** The factory the engine's modules take. */
export const lcdFactory: LcdClientFactory = (chain) => lcdFor(chain);

/** Chain id to client, `null` when the chain is unknown or has no endpoint. */
export function lcdResolver(): LcdResolver {
  return createLcdResolver(chainRegistry(), lcdFactory);
}

/** Drop every cached LCD body. Called when the user turns live reads off. */
export function clearInterchainCaches(): void {
  for (const client of clients.values()) client.clearCache();
  clients.clear();
  channelServiceCache = null;
  denomResolverCache = null;
  registryCache = null;
  clearReadsGateCache();
}

/* -------------------------------------------------------------------------- *
 * Channels
 * -------------------------------------------------------------------------- */

let channelServiceCache: {
  registry: ChainRegistryHandle;
  service: IbcChannelService;
} | null = null;

/**
 * Channel discovery, validation and middleware probing.
 *
 * One instance per chain list: its connection-to-chain-id and module-probe
 * memos are what keep a discovery pass over a hundred channels down to a
 * handful of requests. It is rebuilt when the chain list changes identity,
 * because a service holding the old registry cannot resolve a chain the user
 * has just added.
 */
export function channelService(): IbcChannelService {
  const registry = chainRegistry();
  if (channelServiceCache?.registry === registry) return channelServiceCache.service;
  const service = createIbcChannelService({
    lcd: lcdFactory,
    registry,
    // The extension's switch is labelled "Live balances", so the engine's
    // default "live reads" wording would send the user looking for a control
    // that does not exist under that name.
    messages: { readsDisabled: READS_DISABLED_MESSAGE },
    moduleSupport: MODULE_SUPPORT_PINS,
  });
  channelServiceCache = { registry, service };
  return service;
}

/* -------------------------------------------------------------------------- *
 * Denoms
 * -------------------------------------------------------------------------- */

let denomResolverCache: {
  registry: ChainRegistryHandle;
  resolver: DenomResolver;
} | null = null;

/**
 * Denom traces, `ibc/HASH` arithmetic and unwind planning.
 *
 * The counterparty lookup is wired to the channel service, so an `ibc/…` denom
 * can be walked back to the chain that actually issued it instead of being
 * guessed from whichever registry row claims the base denom.
 *
 * Rebuilt with the chain list for the same reason the channel service is: its
 * trace cache is keyed by chain and a stale registry cannot see a new one.
 */
export function denomResolver(): DenomResolver {
  const registry = chainRegistry();
  if (denomResolverCache?.registry === registry) return denomResolverCache.resolver;
  const channels = channelService();
  const resolver = createDenomResolver({
    lcd: lcdFactory,
    registry,
    counterparty: async (chainId, portId, channelId, options) => {
      const check = await channels.validateIbcChannel(chainId, channelId, undefined, {
        portId,
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      return check.counterpartyChainId ?? null;
    },
  });
  denomResolverCache = { registry, resolver };
  return resolver;
}

/* -------------------------------------------------------------------------- *
 * Light-client status
 * -------------------------------------------------------------------------- */

/**
 * What one chain says about the light client behind one of its channels.
 *
 * - `ok`: the chain named the client and its status (`Active`, `Expired`,
 *   `Frozen`, `Unknown` or `Unauthorized`, ibc-go's spelling).
 * - `unsupported`: the node does not serve the route, so there is no answer
 *   to be had from it, now or on a retry.
 * - `unreachable`: nothing was learned. A retry may do better.
 */
export type ChannelClientRead =
  | {
      readonly kind: "ok";
      readonly clientId: string;
      /** Chain the client tracks. `null` for a client type that does not say. */
      readonly trackedChainId: string | null;
      readonly status: string;
    }
  | { readonly kind: "unsupported"; readonly detail: string }
  | { readonly kind: "unreachable"; readonly detail: string };

/** Client status changes on the scale of a relayer going quiet for days. */
const CLIENT_STATUS_CACHE_MS = 30_000;

/**
 * HTTP answers meaning "this node does not serve the route": a gRPC gateway
 * says 501 for a query service the chain does not register, and proxies in
 * front of public LCDs say 404 or 405. Same set as the engine's channel module.
 */
const ROUTE_ABSENT_STATUSES: ReadonlySet<number> = new Set([404, 405, 501]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Turn a failed read into an answer. A cancel or the reads gate is not one. */
function clientReadFailure(error: unknown, what: string): ChannelClientRead {
  if (isInterchainError(error)) {
    if (error.code === "aborted" || error.code === "reads-disabled") throw error;
    if (error.httpStatus !== undefined && ROUTE_ABSENT_STATUSES.has(error.httpStatus)) {
      return { kind: "unsupported", detail: `${what}: HTTP ${error.httpStatus}` };
    }
  }
  return {
    kind: "unreachable",
    detail: `${what}: ${error instanceof Error ? error.message : String(error)}`,
  };
}

/**
 * Read the light client behind `channelId` on `chainId`, and its status.
 *
 * Two reads: `/channels/{ch}/ports/{port}/client_state` names the client and
 * the chain it tracks, then `/client/v1/client_status/{id}` says whether it is
 * still Active. A channel can stay `STATE_OPEN` for years after its client
 * expired (Osmosis channel-109 to Injective is one): every packet sent into it
 * then times out, because nothing can prove it arrived. The channel state alone
 * cannot see that, which is why the engine's channel check is not enough.
 *
 * The engine has no client-status read yet, so this is the host's. It moves
 * next to `validateIbcChannel` when the SDK grows one.
 *
 * @throws {@link InterchainError} `aborted` or `reads-disabled` only.
 */
export async function readChannelClient(
  chainId: string,
  channelId: string,
  portId: string,
  options: { signal?: AbortSignal } = {},
): Promise<ChannelClientRead> {
  const chain = chainRegistry().get(chainId);
  if (!chain) return { kind: "unreachable", detail: `${chainId} is not in the chain list` };
  let client: LcdClientHandle;
  try {
    client = lcdFor(chain);
  } catch (error) {
    return clientReadFailure(error, `${chainId} has no REST endpoint`);
  }
  const request = {
    cacheTtlMs: CLIENT_STATUS_CACHE_MS,
    ...(options.signal ? { signal: options.signal } : {}),
  };

  let clientId: string | null;
  let trackedChainId: string | null;
  try {
    const body = await client.getJson(
      `/ibc/core/channel/v1/channels/${encodeURIComponent(channelId)}/ports/${encodeURIComponent(portId)}/client_state`,
      request,
    );
    const identified = asRecord(asRecord(body)?.identified_client_state);
    clientId = asText(identified?.client_id);
    trackedChainId = asText(asRecord(identified?.client_state)?.chain_id);
  } catch (error) {
    return clientReadFailure(error, `client_state of ${channelId} on ${chainId}`);
  }
  if (!clientId) {
    return { kind: "unreachable", detail: `${chainId} named no client for ${channelId}` };
  }

  try {
    const body = await client.getJson(
      `/ibc/core/client/v1/client_status/${encodeURIComponent(clientId)}`,
      request,
    );
    const status = asText(asRecord(body)?.status);
    if (!status) {
      return { kind: "unreachable", detail: `${chainId} gave no status for ${clientId}` };
    }
    return { kind: "ok", clientId, trackedChainId, status };
  } catch (error) {
    return clientReadFailure(error, `client_status of ${clientId} on ${chainId}`);
  }
}

/* -------------------------------------------------------------------------- *
 * Canonical channels
 * -------------------------------------------------------------------------- */

/**
 * The chain registry's canonical transfer channel for each pair of catalog
 * mainnets, as seed rows: `source: "seed"`, `verifiedAt: 0`.
 *
 * Generated from cosmos/chain-registry `_IBC` by
 * scripts/generate-ibc-channels.mjs, because discovery cannot be relied on to
 * find these: on a fresh install it returned nothing for Osmosis to Noble or
 * Injective, and where it finds parallel channels it ranks an expired one
 * first. Seeds are still checked on chain before a plan that uses one can be
 * signed (`lib/route-plan.ts`).
 */
export const CANONICAL_CHANNEL_ROUTES: readonly ChannelRoute[] = Object.freeze(
  IBC_CHANNEL_ROWS.map(([sourceChainId, channelId, destChainId, counterpartyChannelId]) =>
    Object.freeze({
      sourceChainId,
      destChainId,
      channelId,
      counterpartyChannelId,
      verifiedAt: 0,
      source: "seed" as const,
    }),
  ),
);

let canonicalIndex: Map<string, readonly string[]> | null = null;

function pairKey(sourceChainId: string, destChainId: string): string {
  // NUL cannot appear in a chain id, so two pairs never share a key.
  return `${sourceChainId}\u0000${destChainId}`;
}

/**
 * The canonical channel ids leaving `sourceChainId` for `destChainId`.
 *
 * Almost always one. Empty when the registry names none for the pair. The
 * engine's own two seeds (the Hub and Osmosis) are the same pair the registry
 * names and are included, so the answer never depends on which table a row
 * came from.
 */
export function canonicalChannelIds(
  sourceChainId: string,
  destChainId: string,
): readonly string[] {
  if (!canonicalIndex) {
    const index = new Map<string, string[]>();
    for (const route of [...SEED_CHANNEL_ROUTES, ...CANONICAL_CHANNEL_ROUTES]) {
      const key = pairKey(route.sourceChainId, route.destChainId);
      const ids = index.get(key) ?? [];
      if (!ids.includes(route.channelId)) ids.push(route.channelId);
      index.set(key, ids);
    }
    canonicalIndex = index;
  }
  return canonicalIndex.get(pairKey(sourceChainId, destChainId)) ?? [];
}

/** Whether the registry names `channelId` as the canonical channel for this direction. */
export function isCanonicalChannel(
  sourceChainId: string,
  destChainId: string,
  channelId: string,
): boolean {
  return canonicalChannelIds(sourceChainId, destChainId).includes(channelId);
}

/* -------------------------------------------------------------------------- *
 * The channel-route cache
 * -------------------------------------------------------------------------- */

/**
 * Channels the wallet has discovered or the user has entered, persisted so a
 * route survives a popup close.
 *
 * Seeded with the engine's `SEED_CHANNEL_ROUTES` and the registry's canonical
 * channels. Both carry `verifiedAt: 0` and are therefore shown as unverified
 * until something checks them.
 */
export async function loadRouteRegistry(): Promise<RouteRegistry> {
  const stored = (await browser.storage.local.get(STORAGE_KEYS.channelRoutes))[
    STORAGE_KEYS.channelRoutes
  ];
  const registry = deserializeRouteRegistry(stored);
  registry.putMany(SEED_CHANNEL_ROUTES);
  registry.putMany(CANONICAL_CHANNEL_ROUTES);
  return registry;
}

/**
 * Persist the registry. Rows are plain JSON; nothing secret is written.
 *
 * Seed rows are left out: they are compiled in and re-added by every load, so
 * writing a thousand of them back on each save would only grow the stored
 * snapshot. A seed the wallet has since verified is a `discovered` row by then
 * and is kept.
 */
export async function saveRouteRegistry(registry: RouteRegistry): Promise<void> {
  const snapshot: RouteRegistrySnapshot = {
    version: 1,
    routes: registry.list().filter((route) => route.source !== "seed"),
  };
  await browser.storage.local.set({ [STORAGE_KEYS.channelRoutes]: snapshot });
}

let registryWrites: Promise<unknown> = Promise.resolve();

/**
 * Load, change and save the route cache as one step.
 *
 * Channel checks run in parallel, and each one used to load the cache, add its
 * row and save. Two finishing together wrote back two different copies and the
 * first row was lost. Writes from this context are queued instead, so each
 * starts from the previous one's result.
 */
export function updateRouteRegistry<T>(
  change: (registry: RouteRegistry) => T | Promise<T>,
): Promise<T> {
  const run = registryWrites.then(async () => {
    const registry = await loadRouteRegistry();
    const result = await change(registry);
    await saveRouteRegistry(registry);
    return result;
  });
  // A failed write must not wedge the queue for every later one.
  registryWrites = run.catch(() => undefined);
  return run;
}

/* -------------------------------------------------------------------------- *
 * The swap venue
 * -------------------------------------------------------------------------- */

/** Why the swap path is unavailable, in the words the UI shows. */
export type SwapVenueProblem =
  | "unset"
  | "chain-missing"
  | "no-endpoint"
  | "reads-disabled"
  | "unreachable"
  | "absent";

/** The result of checking the configured crosschain-swaps contract on chain. */
export interface SwapVenueCheck {
  /** The venue, or `null` when the swap path must stay disabled. */
  readonly venue: SwapVenue | null;
  /** The address that was checked, even when the check failed. */
  readonly contractAddress: string | null;
  readonly chainId: string;
  readonly problem: SwapVenueProblem | null;
  /**
   * The contract's on-chain `label`, when the check succeeded.
   *
   * Shown next to the address because it is the chain's own description of what
   * is deployed there (the mainnet deployment reads "CrossChainSwaps v1.2"),
   * and it lets a user tell a real deployment from a lookalike address.
   */
  readonly label: string | null;
  /** One sentence naming what is wrong and what the user can do. */
  readonly reason: string | null;
  /** `Date.now()` of a successful check. */
  readonly verifiedAt: number | null;
}

/**
 * Addresses to check, in order: the user's override first, then the documented
 * candidates.
 *
 * A list rather than a single value because these are deployments, and a
 * migrated contract would otherwise leave the feature dead until the extension
 * ships again. Order is trust order; every entry is still checked on chain
 * before it is used, so a stale first entry costs one query and not a wrong
 * memo. Empty means the swap path stays off.
 */
export async function swapContractCandidates(): Promise<string[]> {
  const stored = (await browser.storage.local.get(STORAGE_KEYS.swapContract))[
    STORAGE_KEYS.swapContract
  ];
  const override =
    typeof stored === "string" && stored.trim().length > 0 ? stored.trim() : null;
  const out = override ? [override] : [];
  for (const candidate of XCS_CONTRACT_CANDIDATES) {
    if (!out.includes(candidate)) out.push(candidate);
  }
  return out;
}

/**
 * Pin a contract address ahead of the shipped candidates, or clear the pin with
 * `null`.
 *
 * The escape hatch for a migrated deployment: the address is still verified on
 * chain before any memo is built, so this changes what is checked, never
 * whether it is checked.
 */
export async function setSwapContract(address: string | null): Promise<void> {
  venueCache = null;
  if (address === null) {
    await browser.storage.local.remove(STORAGE_KEYS.swapContract);
    return;
  }
  await browser.storage.local.set({ [STORAGE_KEYS.swapContract]: address.trim() });
}

let venueCache: { at: number; address: string; check: SwapVenueCheck } | null = null;
const VENUE_CACHE_MS = 5 * 60_000;

/**
 * Confirm the crosschain-swaps contract exists on the venue chain.
 *
 * The addresses in `config/interchain.ts` are unverified candidates from
 * governance and documentation. A memo built against an address that is not a
 * contract does not fail loudly: the packet arrives, ibc-hooks finds no
 * contract, the transfer errors and the funds come back, or worse, the address
 * is a plain account and the funds simply land there. So the address is checked
 * against `/cosmwasm/wasm/v1/contract/{addr}` before any swap control is
 * enabled, and the whole feature fails closed with a named reason otherwise.
 */
export async function verifySwapVenue(options?: {
  signal?: AbortSignal;
  force?: boolean;
}): Promise<SwapVenueCheck> {
  const chainId = SWAP_VENUE_CHAIN_ID;
  const candidates = await swapContractCandidates();
  const address = candidates[0];
  if (!address) {
    return {
      venue: null,
      contractAddress: null,
      chainId,
      label: null,
      problem: "unset",
      reason:
        "No crosschain-swaps contract is configured, so Zunia has nothing to verify and will not guess an address.",
      verifiedAt: null,
    };
  }
  if (
    !options?.force &&
    venueCache &&
    venueCache.address === address &&
    Date.now() - venueCache.at < VENUE_CACHE_MS
  ) {
    return venueCache.check;
  }

  const chain = chainRegistry().get(chainId);
  if (!chain) {
    return {
      venue: null,
      contractAddress: address,
      chainId,
      label: null,
      problem: "chain-missing",
      reason: `${chainId} is not in this wallet's chain list, so the swap venue cannot be reached.`,
      verifiedAt: null,
    };
  }
  if (lcdEndpointsFromChain(chain).length === 0) {
    return {
      venue: null,
      contractAddress: address,
      chainId,
      label: null,
      problem: "no-endpoint",
      reason: `${chain.chainName} has no REST endpoint in the chain list, so the contract cannot be checked.`,
      verifiedAt: null,
    };
  }

  let lastFailure: SwapVenueCheck | null = null;
  for (const candidate of candidates) {
    const outcome = await checkOneContract(chain, candidate, options);
    if (outcome.venue) {
      // Keyed by the head of the candidate list, which is what a user override
      // changes; the verified address is inside the cached result.
      venueCache = { at: Date.now(), address, check: outcome };
      return outcome;
    }
    lastFailure = outcome;
    // A local gate or an unreachable endpoint says nothing about the other
    // candidates, so stop rather than reporting them all as absent.
    if (outcome.problem !== "absent") break;
  }
  return (
    lastFailure ?? {
      venue: null,
      contractAddress: address,
      chainId,
      label: null,
      problem: "absent",
      reason: `No contract at ${address}.`,
      verifiedAt: null,
    }
  );
}

/**
 * One `/cosmwasm/wasm/v1/contract/{addr}` check. Never throws.
 *
 * Every failure it returns names the address it actually checked, so a report
 * about the third candidate cannot be attributed to the first.
 */
async function checkOneContract(
  chain: ChainInfoLike,
  address: string,
  options?: { signal?: AbortSignal },
): Promise<SwapVenueCheck> {
  const chainId = chain.chainId;
  const failure = (problem: SwapVenueProblem, reason: string): SwapVenueCheck => ({
    venue: null,
    contractAddress: address,
    chainId,
    problem,
    reason,
    label: null,
    verifiedAt: null,
  });
  try {
    const body = await lcdFor(chain).getJson(
      `/cosmwasm/wasm/v1/contract/${encodeURIComponent(address)}`,
      {
        cacheTtlMs: VENUE_CACHE_MS,
        ...(options?.signal ? { signal: options.signal } : {}),
      },
    );
    // Narrow by hand: the LCD's shape is `{ address, contract_info: {…} }` and
    // an endpoint that answers 200 with something else is not evidence.
    const row = body as { address?: unknown; contract_info?: unknown } | null;
    const info =
      typeof row?.contract_info === "object" && row.contract_info !== null
        ? (row.contract_info as { label?: unknown })
        : null;
    const confirmed =
      typeof row?.address === "string" && row.address === address && info !== null;
    if (!confirmed) {
      return failure(
        "absent",
        `${address} is not a CosmWasm contract on ${chain.chainName}. Swaps stay off until a verified address is configured.`,
      );
    }
    return {
      venue: {
        chainId,
        contractAddress: address,
        label: chain.chainName,
        // Deliberately no `denoms` list: the wallet does not hold the venue's
        // tradeable set, and the engine warns about that rather than pretending
        // a pair exists. The quote is what proves a pair is tradeable.
      },
      contractAddress: address,
      chainId,
      problem: null,
      reason: null,
      label: typeof info?.label === "string" ? info.label : null,
      verifiedAt: Date.now(),
    };
  } catch (error) {
    if (isInterchainError(error)) {
      if (error.code === "reads-disabled") {
        return failure("reads-disabled", READS_DISABLED_MESSAGE);
      }
      if (error.httpStatus === 404 || error.httpStatus === 400) {
        return failure(
          "absent",
          `${chain.chainName} has no contract at ${address}. Swaps stay off until a verified address is configured.`,
        );
      }
    }
    return failure(
      "unreachable",
      `Could not reach ${chain.chainName} to check the crosschain-swaps contract, so swaps stay off rather than sending a packet at an unchecked address.`,
    );
  }
}

/* -------------------------------------------------------------------------- *
 * The swap router
 * -------------------------------------------------------------------------- */

let routerCache: LcdClient | null = null;

/**
 * The Osmosis SQS router, as its own read client.
 *
 * The chain cannot search pools by denom pair, so without this there is no
 * quote and the swap confirm control stays disabled. It is a separate host from
 * the chain's LCD, so it gets its own client and the same privacy gate.
 */
export function swapRouterClient(): LcdClient {
  if (routerCache) return routerCache;
  routerCache = createLcdClient({
    // Not a chain: the id is only used for error reporting and cache keys, and
    // naming it after Osmosis would make a router outage read as a chain outage.
    chainId: "osmosis-sqs-router",
    endpoints: SWAP_ROUTER_ENDPOINTS,
    timeoutMs: 9_000,
    retries: 1,
    cacheTtlMs: 5_000,
    readsAllowed: interchainReadsAllowed,
  });
  return routerCache;
}

/* -------------------------------------------------------------------------- *
 * Error copy
 * -------------------------------------------------------------------------- */

/**
 * Turn anything the engine threw into one sentence the user can act on.
 *
 * Keyed off `InterchainError.code`, never off message text: the codes are the
 * engine's contract and each one has a distinct next action.
 */
export function describeInterchainError(error: unknown): string {
  if (isInterchainError(error)) {
    switch (error.code) {
      case "reads-disabled":
        return READS_DISABLED_MESSAGE;
      case "lcd-unreachable":
        return `Could not reach ${chainLabel(error.chainId)}. Its public endpoint is down or slow; try again in a moment.`;
      case "malformed-response":
        return `${chainLabel(error.chainId)} answered with something Zunia could not read, so nothing here is trustworthy. Try again or switch endpoint.`;
      case "no-route":
        return "No route exists between these two chains for this asset.";
      case "channel-closed":
        return `A channel on this path is not open${error.channelId ? ` (${error.channelId})` : ""}. Pick another channel.`;
      case "unsupported-chain":
        return error.message;
      case "unsupported-environment":
        return "This page is missing a browser API Zunia needs. Reload the extension.";
      case "invalid-request":
      case "invalid-memo":
        return error.message;
      case "slippage-exceeded":
        return "The price moved past your slippage tolerance before this could be signed. Re-quote or raise the tolerance.";
      case "packet-timeout":
        return "The packet timed out. The funds were refunded on the source chain.";
      case "contract-error":
        return error.message;
      case "tx-rejected":
        return error.message;
      case "aborted":
        return "Cancelled.";
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

function chainLabel(chainId: string | undefined): string {
  if (!chainId) return "the chain";
  return findCatalogEntry(chainId)?.chainName ?? chainId;
}
