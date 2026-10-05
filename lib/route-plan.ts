/**
 * Route planning for cross-chain transfers and cross-chain swaps.
 *
 * Every decision here is the engine's: `planRoute` picks the hops and composes
 * the PFM / ibc-hooks memo, `recommendDenom` decides whether a wrapped token
 * unwinds, `quoteOsmosisSwap` prices the pool, and `validateMemo` says what the
 * memo will do. This module only supplies the host's ports (chain list, LCD,
 * channel cache, addresses) and turns the results into the shapes the popup
 * screens render.
 *
 * One question is the host's: may a channel the engine picked carry the
 * transfer at all? A channel can stay `STATE_OPEN` for years after its light
 * client expired, and every packet sent into it is then lost to a timeout. So
 * every channel on a plan's path is checked on both chains (open, each end
 * naming the other, both light clients Active) before the plan is offered for
 * signing, and a channel that fails is dropped from the graph and the route
 * planned again.
 *
 * Nothing here signs or broadcasts. It is safe to run in the popup, and does,
 * so a long plan can be cancelled with an `AbortSignal` when the user edits the
 * form instead of blocking a background worker that MV3 may kill mid-flight.
 */

import {
  buildExecuteContractMsg,
  buildPlanTransferMsg,
  createChannelDirectory,
  findRoutePaths,
  normalizeChannelId,
  planRoute,
  quoteOsmosisSwap,
  readXcsExecutableRoute,
  validateMemo,
  routeDenomResolver,
  InterchainError,
  PFM_INTERMEDIATE_RECEIVER,
  TRANSFER_PORT,
  isInterchainError,
  type BuiltMsg,
  type JsonObject,
  type ChainCapabilities,
  type ChannelDirectory,
  type ChannelLink,
  type ChannelLinkSource,
  type ChannelRoute,
  type IbcChannelOption,
  type IbcChannelValidation,
  type MemoInspection,
  type OsmosisSwapQuote,
  type RouteHopKind,
  type RouteHopOverride,
  type RoutePlan,
  type RoutePlanCandidate,
  type SwapVenue,
} from "@zunialab/interchain";

import {
  DEFAULT_SLIPPAGE_PERCENT,
  MAX_ROUTE_HOPS,
  PACKET_TIMEOUT_MINUTES,
  SWAP_VENUE_CHAIN_ID,
} from "../config/interchain";
import { catalogIconFor, findCatalogEntry } from "./chain-catalog";
import { classifyChannelCheck, type ChannelVerdictKind } from "./channel-verdict";
import {
  canonicalChannelIds,
  channelService,
  chainRegistry,
  denomResolver,
  describeInterchainError,
  isCanonicalChannel,
  loadRouteRegistry,
  lcdFor,
  readChannelClient,
  swapRouterClient,
  updateRouteRegistry,
} from "./interchain";

/* -------------------------------------------------------------------------- *
 * Shapes the screens render
 * -------------------------------------------------------------------------- */

/** A channel the user typed in, pinned onto one leg of the route. */
export interface ManualChannel {
  readonly fromChainId: string;
  readonly toChainId: string;
  readonly channelId: string;
  readonly counterpartyChannelId?: string;
  /** Port on the leaving chain. `transfer` when absent. */
  readonly port?: string;
  /** What the on-chain check concluded when the user picked it. */
  readonly verdict?: ChannelVerdictKind;
}

/**
 * One leg of a planned route, ready for `RoutePreview` and for the per-hop
 * channel picker.
 *
 * Field names match `RoutePreviewHop` in `@zunialab/ui` so the object spreads
 * straight into the component.
 */
export interface RouteHopView {
  readonly index: number;
  readonly chainId: string;
  readonly chainName: string;
  readonly chainIconUrl?: string;
  readonly counterpartyChainId: string | null;
  readonly counterpartyChainName?: string;
  readonly counterpartyChainIconUrl?: string;
  readonly channelId: string;
  readonly port: string;
  readonly kind: RouteHopKind;
  readonly channelSource?: "discovered" | "manual" | "seed";
  readonly channelVerified?: boolean;
  readonly channelState?: "open" | "closed" | "init" | "tryopen" | "unknown";
}

/** A plan plus everything the confirm screen needs to describe and block it. */
export interface RoutePlanView {
  readonly plan: RoutePlan;
  readonly candidate: RoutePlanCandidate;
  /** ICS20 receiver of the one transfer the user signs. */
  readonly receiver: string;
  readonly hops: readonly RouteHopView[];
  readonly warnings: readonly string[];
  /** What the memo will do, from the engine's own classifier. */
  readonly memo: MemoInspection;
  /**
   * Set when the plan cannot be signed as-is, in the words the button shows.
   * A placeholder PFM receiver is the load-bearing case: signing it sends funds
   * to a literal `"pfm"` and they are gone. A channel on the path that failed
   * its on-chain check, or was never checked, blocks the plan the same way.
   */
  readonly blockedReason: string | null;
  /**
   * The channel check that failed on this plan's path, or could not be
   * completed (`verdict` says which); `null` when none did.
   *
   * Lets a screen act on a refusal without matching sentences: a route the
   * screen pinned on its own (Send pins the path it previews) can drop that
   * pin and plan again, and an `inconclusive` one can offer a retry. A pin the
   * user typed stays theirs to change.
   */
  readonly failedCheck: ChannelHopCheck | null;
}

/** Result of planning a same-asset cross-chain transfer. */
export interface TransferPlanResult {
  readonly best: RoutePlanView | null;
  readonly alternatives: readonly RoutePlanView[];
  /** Planner-level notes: why some route was not offered at all. */
  readonly warnings: readonly string[];
  readonly error: string | null;
}

/**
 * The known reasons a swap has no price, so a screen can word them with the
 * tokens' own names instead of repeating the sentence.
 *
 * - `no-contract-route`: the crosschain-swaps contract's route table has no
 *   entry for the pair, so the packet would be rejected.
 * - `route-unreadable`: the route table could not be read.
 * - `route-unpriced`: the pools on the contract's route could not be priced.
 * - `same-token`: both sides are the same denom on the venue.
 * - `venue-denom-mismatch`: the route would trade a different denom on the
 *   venue than the caller's `expectedVenue*Denom` names. The plan is blocked
 *   too, not just unpriced.
 */
export type SwapQuoteBlockedCode =
  | "no-contract-route"
  | "route-unreadable"
  | "route-unpriced"
  | "same-token"
  | "venue-denom-mismatch";

/** Result of planning a cross-chain swap, including its price. */
export interface SwapPlanResult extends TransferPlanResult {
  readonly quote: OsmosisSwapQuote | null;
  /** Why there is no quote, when there is none. Never `null` alongside a `null` quote and a plan. */
  readonly quoteBlockedReason: string | null;
  /**
   * Which known reason {@link quoteBlockedReason} is. `null` when there is no
   * block, and for reasons without a code (no transfer into the venue, an input
   * the venue cannot name, a channel that failed its check), whose sentence is
   * then the only copy.
   */
  readonly quoteBlockedCode: SwapQuoteBlockedCode | null;
  /** Denom the swap sells, as the venue chain names it. */
  readonly venueInputDenom: string | null;
  /** Denom the swap buys, as the venue chain names it (`output_denom` in the memo). */
  readonly venueOutputDenom: string | null;
  readonly venue: SwapVenue | null;
}

/* -------------------------------------------------------------------------- *
 * The channel graph
 * -------------------------------------------------------------------------- */

function linkSourceOf(route: ChannelRoute): ChannelLinkSource {
  // "discovered" means we read it off the chain this session or recently, which
  // is what the planner calls "verified". "seed" is a shipped guess and stays a
  // guess until something checks it.
  if (route.source === "manual") return "manual";
  return route.source === "discovered" ? "verified" : "seed";
}

function routeToLink(route: ChannelRoute): ChannelLink {
  // A channel this session checked on both chains is verified whatever the
  // cache row says, so it ranks above unchecked ones. A manual row stays
  // manual: that is about who chose it, not whether it was checked.
  const confirmed = sessionConfirmed(
    route.sourceChainId,
    route.destChainId,
    route.channelId,
    TRANSFER_PORT,
  );
  return {
    sourceChainId: route.sourceChainId,
    destChainId: route.destChainId,
    channelId: route.channelId,
    port: TRANSFER_PORT,
    ...(route.counterpartyChannelId
      ? { counterpartyChannelId: route.counterpartyChannelId }
      : {}),
    source: confirmed && route.source !== "manual" ? "verified" : linkSourceOf(route),
    // `verifiedAt` is the only evidence we have that the channel was open. A
    // seed row carries 0 and must never render as open.
    state: confirmed || route.verifiedAt > 0 ? "open" : "unknown",
  };
}

/** What the graph knows about channels beyond the cache rows themselves. */
export interface RoutingKnowledge {
  /** The registry's canonical channel ids for one direction; empty when it names none. */
  readonly canonical: (sourceChainId: string, destChainId: string) => readonly string[];
  /** True for a channel a chain has ruled out: expired client, closed, leading elsewhere. */
  readonly refused: (link: ChannelLink) => boolean;
}

/**
 * The channels leaving one chain that automatic routing may use.
 *
 * Two rules, both about channels the cache remembers but the chains have moved
 * past:
 *
 * - A channel this session found unusable is dropped, whoever entered it.
 * - Where the registry names a canonical channel for a pair, and it has not
 *   been ruled out, every other non-manual channel for that pair is dropped.
 *   Discovery once cached Injective channel-5 and Osmosis channel-109, both
 *   still `STATE_OPEN` and both with Expired clients, and the planner ranks
 *   parallel channels by number, so the dead one won. A channel the user
 *   entered by hand stays: it is an instruction, and it is still checked.
 *
 * When the canonical channel itself is ruled out, the pair falls back to the
 * other rows, which are checked like any other.
 */
export function routableLinks(
  links: readonly ChannelLink[],
  knowledge: RoutingKnowledge,
): ChannelLink[] {
  const live = links.filter((link) => !knowledge.refused(link));
  const isCanonical = (link: ChannelLink): boolean =>
    (link.port ?? TRANSFER_PORT) === TRANSFER_PORT &&
    knowledge.canonical(link.sourceChainId, link.destChainId).includes(link.channelId);
  const covered = new Set(
    live.filter(isCanonical).map((link) => `${link.sourceChainId}\u0000${link.destChainId}`),
  );
  return live.filter(
    (link) =>
      link.source === "manual" ||
      isCanonical(link) ||
      !covered.has(`${link.sourceChainId}\u0000${link.destChainId}`),
  );
}

/**
 * A directory that answers through {@link routableLinks}.
 *
 * Filtered at the link level rather than on the cache rows, so a reverse link
 * the directory derives from a row's counterparty is filtered too. Answers are
 * memoised per chain because the path search asks for the same chain many
 * times.
 */
export function routableDirectory(
  base: ChannelDirectory,
  knowledge: RoutingKnowledge,
): ChannelDirectory {
  const memo = new Map<string, readonly ChannelLink[]>();
  return {
    from(chainId: string): readonly ChannelLink[] {
      let links = memo.get(chainId);
      if (!links) {
        links = routableLinks(base.from(chainId), knowledge);
        memo.set(chainId, links);
      }
      return links;
    },
  };
}

/**
 * Everything the wallet currently believes about the channel graph, narrowed
 * to what automatic routing may use (see {@link routableLinks}).
 */
export async function channelDirectory(): Promise<ChannelDirectory> {
  const registry = await loadRouteRegistry();
  return routableDirectory(createChannelDirectory(registry.list().map(routeToLink)), {
    canonical: canonicalChannelIds,
    refused: sessionRefused,
  });
}

/**
 * Discover open transfer channels between two chains and remember them.
 *
 * Returns an empty list for the ordinary reasons (same chain, no endpoint,
 * live reads off, nothing matched), which the caller must present as "none
 * found, enter one" rather than as a failure.
 */
export async function discoverChannels(
  sourceChainId: string,
  destChainId: string,
  options: { signal?: AbortSignal } = {},
): Promise<readonly IbcChannelOption[]> {
  const found = await channelService().findIbcChannels(sourceChainId, destChainId, {
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (found.length === 0) return found;

  const now = Date.now();
  await updateRouteRegistry((registry) => {
    registry.putMany(
      found.map((option) => ({
        sourceChainId,
        destChainId,
        channelId: option.channelId,
        counterpartyChannelId: option.counterpartyChannelId,
        verifiedAt: now,
        source: "discovered" as const,
      })),
    );
  });
  return found;
}

/**
 * Walk every open transfer channel on `sourceChainId` and cache each
 * counterparty. One listing, then the graph can search multi-hop routes
 * without a second walk per destination.
 */
export async function discoverOutgoingChannels(
  sourceChainId: string,
  options: { signal?: AbortSignal } = {},
): Promise<readonly IbcChannelOption[]> {
  const found = await channelService().findOutgoingIbcChannels(sourceChainId, {
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (found.length === 0) return found;

  const now = Date.now();
  await updateRouteRegistry((registry) => {
    registry.putMany(
      found.flatMap((option) =>
        // A channel whose client could not be resolved names no destination,
        // and a route without one cannot be stored or searched.
        option.counterpartyChainId
          ? [
              {
                sourceChainId,
                destChainId: option.counterpartyChainId,
                channelId: option.channelId,
                counterpartyChannelId: option.counterpartyChannelId,
                verifiedAt: now,
                source: "discovered" as const,
              },
            ]
          : [],
      ),
    );
  });
  return found;
}

/* -------------------------------------------------------------------------- *
 * Channel checks
 * -------------------------------------------------------------------------- */

/**
 * What the two chains said about one channel.
 *
 * - `active`: open on both chains, each end names the other, and both light
 *   clients are Active. The only unqualified yes.
 * - `active-unconfirmed`: all of that except the client status, which a node
 *   would not serve. Given only to the chain registry's canonical channel for
 *   the pair, with a warning; every other channel needs the full answer.
 * - `client-inactive`: a light client is Expired, Frozen or otherwise not
 *   Active. The channel can still read as open, and nothing sent into it can
 *   arrive.
 * - `rejected`: closed, missing, pointing elsewhere, or connected to another
 *   chain.
 * - `status-unreadable`: a node would not serve the client status and the
 *   channel is not canonical, so nothing confirms it is live.
 * - `inconclusive`: a chain could not be asked. Proves nothing either way, and
 *   the chains are asked again next time.
 */
export type ChannelHopVerdict =
  | "active"
  | "active-unconfirmed"
  | "client-inactive"
  | "rejected"
  | "status-unreadable"
  | "inconclusive";

/** One channel, checked on both of its chains. */
export interface ChannelHopCheck {
  readonly sourceChainId: string;
  readonly destChainId: string;
  readonly channelId: string;
  readonly portId: string;
  /** The channel's id on {@link destChainId}, when the source chain named it. */
  readonly counterpartyChannelId: string | null;
  readonly verdict: ChannelHopVerdict;
  /** True for `active` and `active-unconfirmed`: the only verdicts a signable plan may cross. */
  readonly usable: boolean;
  /** One sentence naming the channel and both chains. */
  readonly message: string;
  /** A caveat on a channel that is usable anyway. */
  readonly warning: string | null;
  /** `Date.now()` when the chains answered. */
  readonly checkedAt: number;
}

/**
 * How long a check stands before the chains are asked again.
 *
 * A light client expires after days without an update, so a fresher answer
 * would only cost requests on every keystroke of the amount field.
 */
const CHANNEL_CHECK_TTL_MS = 10 * 60_000;

/** This session's definite answers. An inconclusive one is never kept. */
const channelChecks = new Map<string, ChannelHopCheck>();

function checkKey(
  sourceChainId: string,
  destChainId: string,
  channelId: string,
  portId: string,
): string {
  // NUL cannot appear in a chain id, port or channel id, so keys cannot collide.
  return [sourceChainId, destChainId, portId, channelId].join("\u0000");
}

function linkCheckKey(link: ChannelLink): string {
  return checkKey(
    link.sourceChainId,
    link.destChainId,
    // Checks are keyed by the `channel-N` the engine reads. A path that spells
    // a channel any other way is refused before it is checked
    // (`misspelledChannel`), so this never vouches for a different string.
    normalizeChannelId(link.channelId),
    link.port ?? TRANSFER_PORT,
  );
}

function cachedCheck(key: string): ChannelHopCheck | undefined {
  const hit = channelChecks.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.checkedAt <= CHANNEL_CHECK_TTL_MS) return hit;
  channelChecks.delete(key);
  return undefined;
}

function sessionConfirmed(
  sourceChainId: string,
  destChainId: string,
  channelId: string,
  portId: string,
): boolean {
  return cachedCheck(checkKey(sourceChainId, destChainId, channelId, portId))?.usable === true;
}

function sessionRefused(link: ChannelLink): boolean {
  const hit = cachedCheck(linkCheckKey(link));
  return hit !== undefined && !hit.usable;
}

/**
 * Forget this session's channel answers and discovery runs.
 *
 * Both live in this module's memory, so a popup reopen starts fresh anyway;
 * this exists for tests and for a caller that knows the chains changed.
 */
export function resetChannelChecks(): void {
  channelChecks.clear();
  discoveryRuns.clear();
  walkedLegs.clear();
}

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** "expired" and "frozen" read as words; ibc-go's other statuses are quoted as given. */
function clientStatusPhrase(status: string): string {
  const word = status.toLowerCase();
  return word === "expired" || word === "frozen" ? word : `not active (the chain says "${status}")`;
}

/**
 * Ask both chains about one channel. Never answers from the session cache.
 *
 * Three questions, cheapest failure first:
 *
 * 1. Is it open on both chains, and does each end name the other? The engine's
 *    `validateIbcChannel`, with the counterparty check.
 * 2. Does each end's light client track the other chain?
 * 3. Is each light client Active?
 *
 * @throws {@link InterchainError} `aborted` or `reads-disabled` only.
 */
async function inspectChannelHop(
  sourceChainId: string,
  destChainId: string,
  channelId: string,
  portId: string,
  signal: AbortSignal | undefined,
): Promise<ChannelHopCheck> {
  const label = `${channelId} from ${chainName(sourceChainId)} to ${chainName(destChainId)}`;
  const request = signal ? { signal } : {};
  const answer = (
    verdict: ChannelHopVerdict,
    message: string,
    counterpartyChannelId: string | null,
    warning: string | null = null,
  ): ChannelHopCheck => ({
    sourceChainId,
    destChainId,
    channelId,
    portId,
    counterpartyChannelId,
    verdict,
    usable: verdict === "active" || verdict === "active-unconfirmed",
    message,
    warning,
    checkedAt: Date.now(),
  });

  const validation: IbcChannelValidation = await validateChannel(
    sourceChainId,
    channelId,
    destChainId,
    { portId, ...request },
  );
  const counterpartyChannelId = validation.counterpartyChannelId || null;
  const verdict = classifyChannelCheck(validation, destChainId);
  if (verdict.kind === "rejected") {
    return answer(
      "rejected",
      `Zunia will not use ${label}. ${sentence(verdict.note)}`,
      counterpartyChannelId,
    );
  }
  if (verdict.kind !== "verified" || !counterpartyChannelId) {
    return answer(
      "inconclusive",
      `Zunia could not confirm ${label} on both chains, so this route stays unsigned for now. ${sentence(verdict.note)}`,
      counterpartyChannelId,
    );
  }

  const [here, there] = await Promise.all([
    readChannelClient(sourceChainId, channelId, portId, request),
    readChannelClient(
      destChainId,
      counterpartyChannelId,
      validation.counterparty?.portId ?? TRANSFER_PORT,
      request,
    ),
  ]);
  const ends = [
    { chainId: sourceChainId, otherChainId: destChainId, read: here },
    { chainId: destChainId, otherChainId: sourceChainId, read: there },
  ];

  for (const end of ends) {
    const read = end.read;
    if (read.kind === "ok" && read.trackedChainId && read.trackedChainId !== end.otherChainId) {
      return answer(
        "rejected",
        `Zunia will not use ${label}. Its light client on ${chainName(end.chainId)} follows ${chainName(read.trackedChainId)}, not ${chainName(end.otherChainId)}.`,
        counterpartyChannelId,
      );
    }
  }
  for (const end of ends) {
    const read = end.read;
    if (read.kind === "ok" && read.status !== "Active") {
      return answer(
        "client-inactive",
        `Zunia will not use ${label}. Its light client on ${chainName(end.chainId)} is ${clientStatusPhrase(read.status)}, so nothing sent over it can arrive.`,
        counterpartyChannelId,
      );
    }
  }

  // The engine names the far chain from the connection; the client state
  // names it too. One of them has to say it is the destination.
  const tracked = here.kind === "ok" ? here.trackedChainId : null;
  if ((validation.counterpartyChainId ?? tracked) !== destChainId) {
    return answer(
      "inconclusive",
      `Zunia could not confirm that ${label} leads to ${chainName(destChainId)}, so this route stays unsigned for now.`,
      counterpartyChannelId,
    );
  }
  const unreachable = ends.find((end) => end.read.kind === "unreachable");
  if (unreachable) {
    return answer(
      "inconclusive",
      `${chainName(unreachable.chainId)} did not answer for the light-client status of ${label}, so this route stays unsigned for now. Try again in a moment.`,
      counterpartyChannelId,
    );
  }
  const unsupported = ends.find((end) => end.read.kind === "unsupported");
  if (unsupported) {
    const why = `${chainName(unsupported.chainId)} does not report light-client status, so Zunia cannot confirm ${label} is live`;
    if (portId === TRANSFER_PORT && isCanonicalChannel(sourceChainId, destChainId, channelId)) {
      return answer(
        "active-unconfirmed",
        `${label} is open on both chains.`,
        counterpartyChannelId,
        `${why}. It is the chain registry's canonical channel for this pair, so it is used.`,
      );
    }
    return answer(
      "status-unreadable",
      `${why}, and only the chain registry's canonical channel is used without that check.`,
      counterpartyChannelId,
    );
  }
  return answer(
    "active",
    `${label} is open on both chains and both light clients are active.`,
    counterpartyChannelId,
  );
}

/** Write a definite answer to the route cache. Failure is ignored: it is a cache. */
async function recordCheck(check: ChannelHopCheck): Promise<void> {
  await updateRouteRegistry((registry) => {
    if (check.usable) {
      registry.put({
        sourceChainId: check.sourceChainId,
        destChainId: check.destChainId,
        channelId: check.channelId,
        counterpartyChannelId: check.counterpartyChannelId ?? "",
        verifiedAt: check.checkedAt,
        source: "discovered",
      });
      return;
    }
    const row = registry
      .getAll(check.sourceChainId, check.destChainId)
      .find((route) => route.channelId === check.channelId);
    if (row?.source === "discovered") {
      registry.remove(check.sourceChainId, check.destChainId, check.channelId);
    }
  }).catch(() => undefined);
}

/**
 * Check one channel on both chains, or answer from this session's check.
 *
 * A definite answer is kept for the session and written to the route cache: a
 * channel that passed is stored as discovered and verified, and a discovered
 * row that failed is deleted so the cache stops offering it. A manual row is
 * the user's and is never deleted; the session answer keeps it out of
 * automatic routing instead. An inconclusive answer is not kept.
 *
 * @throws {@link InterchainError} `aborted` or `reads-disabled` only.
 */
export async function checkChannelHop(
  sourceChainId: string,
  destChainId: string,
  channelId: string,
  options: { signal?: AbortSignal; portId?: string } = {},
): Promise<ChannelHopCheck> {
  const portId = options.portId ?? TRANSFER_PORT;
  const channel = normalizeChannelId(channelId);
  const key = checkKey(sourceChainId, destChainId, channel, portId);
  const cached = cachedCheck(key);
  if (cached) return cached;

  const check = await inspectChannelHop(
    sourceChainId,
    destChainId,
    channel,
    portId,
    options.signal,
  );
  if (check.verdict === "inconclusive") return check;
  channelChecks.set(key, check);
  // The cache models the transfer port only.
  if (portId === TRANSFER_PORT) await recordCheck(check);
  return check;
}

/**
 * Confirm one hop that the cache already named (a seed, or a guessed channel)
 * and record it as discovered when both chains agree it is open and both
 * light clients are Active.
 *
 * `false` for every other answer, "could not ask" included. A caller that
 * needs the reason uses {@link checkChannelHop}.
 */
export async function verifyChannelHop(
  sourceChainId: string,
  destChainId: string,
  channelId: string,
  options: { signal?: AbortSignal } = {},
): Promise<boolean> {
  const check = await checkChannelHop(sourceChainId, destChainId, channelId, options);
  return check.usable;
}

/**
 * Check one channel id the user typed, on the source chain and on the far side.
 *
 * The counterparty check costs a second chain's round trip and is worth it
 * here: a channel that is open locally but points at a different chain is the
 * one mistake that succeeds and mints a token nothing can name.
 */
export async function validateChannel(
  sourceChainId: string,
  channelId: string,
  destChainId: string | undefined,
  options: { signal?: AbortSignal; portId?: string } = {},
): Promise<IbcChannelValidation> {
  return channelService().validateIbcChannel(sourceChainId, channelId, destChainId, {
    checkCounterparty: true,
    ...(options.portId ? { portId: options.portId } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/**
 * Remember a channel the user entered, so the next plan can use it.
 *
 * Only a channel the chain confirmed end to end is stored as verified; one the
 * user merely typed stays a manual row that never renders as checked. The
 * cache models the transfer port only, so a channel on another port is used
 * for this transfer and not remembered.
 */
export async function rememberManualChannel(input: ManualChannel): Promise<void> {
  if ((input.port ?? TRANSFER_PORT) !== TRANSFER_PORT) return;
  const verified = input.verdict === "verified";
  await updateRouteRegistry((registry) => {
    registry.put({
      sourceChainId: input.fromChainId,
      destChainId: input.toChainId,
      channelId: input.channelId,
      counterpartyChannelId: input.counterpartyChannelId ?? "",
      verifiedAt: verified ? Date.now() : 0,
      source: verified ? "discovered" : "manual",
    });
  });
}

/* -------------------------------------------------------------------------- *
 * Checking a plan's path
 * -------------------------------------------------------------------------- */

/** What checking every channel on one plan's path found. */
interface PathCheck {
  /** Every channel can carry the transfer. */
  readonly ok: boolean;
  /**
   * A channel was ruled out just now, and nothing forces the planner back
   * onto it. Planning again routes around it, because the graph no longer
   * offers it.
   */
  readonly replan: boolean;
  /** Some channel was asked about just now rather than answered from this session. */
  readonly fresh: boolean;
  /** The first reason the plan cannot be signed, naming the channel and both chains. */
  readonly blockedReason: string | null;
  /** The first check on the path that did not pass, if any. */
  readonly failed: ChannelHopCheck | null;
  /** Caveats on channels that are usable anyway. */
  readonly warnings: readonly string[];
  /** Channels confirmed this session, by {@link linkCheckKey}. */
  readonly confirmed: ReadonlySet<string>;
}

const ROUTE_NOT_CHECKED =
  "The channels on this route have not been checked on chain yet, so it cannot be signed as it stands.";

/**
 * Whether the user pinned this leg.
 *
 * The planner applies a pin by chain pair, so planning again would put the
 * same channel straight back. Only the user can change it, and the plan says
 * why it is blocked instead.
 */
function isPinned(check: ChannelHopCheck, pinned: readonly ManualChannel[] | undefined): boolean {
  return (pinned ?? []).some(
    (pin) => pin.fromChainId === check.sourceChainId && pin.toChainId === check.destChainId,
  );
}

function summarize(
  checks: readonly ChannelHopCheck[],
  extra: { replan: boolean; fresh: boolean; unchecked: boolean },
): PathCheck {
  const failed = checks.find((check) => !check.usable);
  return {
    ok: !failed && !extra.unchecked,
    replan: extra.replan,
    fresh: extra.fresh,
    blockedReason: failed?.message ?? (extra.unchecked ? ROUTE_NOT_CHECKED : null),
    failed: failed ?? null,
    warnings: checks.flatMap((check) => (check.warning ? [check.warning] : [])),
    confirmed: new Set(
      checks
        .filter((check) => check.usable)
        .map((check) =>
          checkKey(check.sourceChainId, check.destChainId, check.channelId, check.portId),
        ),
    ),
  };
}

/**
 * A refusal for a channel id the path spells differently from the one a check
 * reads.
 *
 * The engine's check reads `channel-8` for "8", "Channel-8" or " channel-8 ",
 * while the message the user signs carries the spelling it was given. Checking
 * one string and signing another is what the check exists to prevent, so the
 * plan is refused instead. The screens write pins as `channel-N`; this guards
 * every other caller. Never cached: it is about the path, not the channel.
 */
function misspelledChannel(link: ChannelLink): ChannelHopCheck | null {
  const written = normalizeChannelId(link.channelId);
  if (written === link.channelId) return null;
  return {
    sourceChainId: link.sourceChainId,
    destChainId: link.destChainId,
    channelId: link.channelId,
    portId: link.port ?? TRANSFER_PORT,
    counterpartyChannelId: null,
    verdict: "rejected",
    usable: false,
    message: `The route names the channel from ${chainName(link.sourceChainId)} to ${chainName(link.destChainId)} as "${link.channelId}", which is not how the chain writes it ("${written}"), so Zunia will not sign it.`,
    warning: null,
    checkedAt: Date.now(),
  };
}

/**
 * Check every channel on a path, in parallel, answering from this session's
 * checks where it can.
 *
 * Only a refusal learned in this call asks for another round. One the session
 * already knew was refused while the graph was built, so the planner did not
 * find the channel there: it was forced onto it, by the user's pin or by the
 * edge a voucher must leave by to unwind. Planning again would pick it again.
 *
 * @throws {@link InterchainError} `aborted` or `reads-disabled` only.
 */
async function checkPath(
  links: readonly ChannelLink[],
  pinned: readonly ManualChannel[] | undefined,
  signal: AbortSignal | undefined,
): Promise<PathCheck> {
  const unknown = new Set(
    links.map(linkCheckKey).filter((key) => cachedCheck(key) === undefined),
  );
  const checks = await Promise.all(
    links.map(
      (link) =>
        misspelledChannel(link) ??
        checkChannelHop(link.sourceChainId, link.destChainId, link.channelId, {
          portId: link.port ?? TRANSFER_PORT,
          ...(signal ? { signal } : {}),
        }),
    ),
  );
  return summarize(checks, {
    replan: checks.some(
      (check) =>
        !check.usable &&
        check.verdict !== "inconclusive" &&
        unknown.has(checkKey(check.sourceChainId, check.destChainId, check.channelId, check.portId)) &&
        !isPinned(check, pinned),
    ),
    fresh: unknown.size > 0,
    unchecked: false,
  });
}

/**
 * The same verdict from this session's answers alone, for alternatives.
 *
 * Alternatives are not checked before they are shown. One with an unchecked
 * channel reads as blocked rather than as a plan that may be signed; choosing
 * it plans it again, and that plan is checked.
 */
function sessionPathCheck(links: readonly ChannelLink[]): PathCheck {
  const known = links.map((link) => misspelledChannel(link) ?? cachedCheck(linkCheckKey(link)));
  const checks = known.filter((check): check is ChannelHopCheck => check !== undefined);
  return summarize(checks, {
    replan: false,
    fresh: false,
    unchecked: checks.length < links.length,
  });
}

/**
 * Whether a planning round should run again.
 *
 * Either a channel was ruled out and the graph can route around it, or the
 * chosen channels were only just confirmed: planning once more against the
 * confirmed graph drops the planner's "not verified" warnings and lets a
 * verified channel outrank a seed.
 */
function planAgain(checked: PathCheck): boolean {
  return checked.replan || (checked.ok && checked.fresh);
}

/* -------------------------------------------------------------------------- *
 * Discovery, as a fallback
 * -------------------------------------------------------------------------- */

/** A leg the graph has no path for: `[from, to]`. */
type Leg = readonly [string, string];

function legKey([from, to]: Leg): string {
  return `${from}\u0000${to}`;
}

/** What reading one leg's channel lists did, for the warning when it found no route. */
interface LegWalk {
  /** Chains whose channel list was read, leaving chain first. */
  readonly read: readonly string[];
  /** Why a list could not be read, naming its chain; `null` when every list was read. */
  readonly failure: string | null;
}

/** Walks in flight, shared so a plan that was cancelled does not start one again. */
const discoveryRuns = new Map<string, Promise<LegWalk>>();
/** Legs whose lists were all read this session, whatever they named. */
const walkedLegs = new Map<string, LegWalk>();

/** Stop waiting when the caller cancels, without cancelling the work. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) {
    return Promise.reject(new InterchainError("aborted", "Planning was cancelled"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void =>
      reject(new InterchainError("aborted", "Planning was cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Read the channel lists for one leg.
 *
 * The leaving chain's list first. When it names no channel to `to` that this
 * session has not already ruled out, the arriving chain's list too, for
 * channels leading back: the cache keeps each channel's far end, so the
 * directory derives the `from` → `to` link from the row the arriving chain
 * names. A leg leaving Osmosis needs that second read. Osmosis lists about a
 * thousand interchain-account channels before any transfer channel, far past
 * the walk's 300-row budget, so its own list never names one.
 *
 * Never rejects: a list that cannot be read is reported in `failure`.
 */
async function walkLeg([from, to]: Leg): Promise<LegWalk> {
  const read: string[] = [];
  const failures: string[] = [];
  const walk = async (chainId: string, otherChainId: string) => {
    try {
      const found = await discoverChannels(chainId, otherChainId);
      read.push(chainId);
      return found;
    } catch (error) {
      failures.push(
        `${chainName(chainId)}'s channel list could not be read. ${sentence(describeInterchainError(error))}`,
      );
      return [];
    }
  };
  const leaving = await walk(from, to);
  const usable = leaving.some(
    (option) =>
      !sessionRefused({
        sourceChainId: from,
        destChainId: to,
        channelId: option.channelId,
        port: option.portId,
      }),
  );
  if (!usable) await walk(to, from);
  return { read, failure: failures.length > 0 ? failures.join(" ") : null };
}

/**
 * Read one leg's channel lists, at most once per session.
 *
 * Detached from the caller's signal on purpose: a walk is several LCD pages,
 * and the user editing the amount should not throw it away. A cancelled plan
 * stops waiting; the walk finishes for the next one. A leg whose list could
 * not be read is read again by a later plan.
 */
function discoverOnce(leg: Leg, signal: AbortSignal | undefined): Promise<LegWalk> {
  const key = legKey(leg);
  let run = discoveryRuns.get(key);
  if (!run) {
    run = walkLeg(leg).then((walked) => {
      if (walked.failure === null) walkedLegs.set(key, walked);
      return walked;
    });
    discoveryRuns.set(key, run);
    const done = (): void => void discoveryRuns.delete(key);
    run.then(done, done);
  }
  return untilAborted(run, signal);
}

/**
 * Run discovery for the legs that have no path, each once per session.
 *
 * Returns whether anything ran, so the caller knows a replan can see more than
 * the last one did. `tried` collects what each leg's walk read.
 */
async function discoverLegs(
  legs: readonly Leg[],
  tried: Map<string, LegWalk>,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const pending = legs.filter(
    (leg) => !walkedLegs.has(legKey(leg)) && !tried.has(legKey(leg)),
  );
  if (pending.length === 0) return false;
  await Promise.all(
    pending.map(async (leg) => {
      tried.set(legKey(leg), await discoverOnce(leg, signal));
    }),
  );
  return true;
}

/** The legs among `legs` the graph has no path for within `maxHops`. */
function missingLegs(
  directory: ChannelDirectory,
  legs: readonly Leg[],
  maxHops: number,
): Leg[] {
  return legs.filter(
    ([from, to]) =>
      from !== to && findRoutePaths(from, to, directory, { maxHops, maxPaths: 1 }).length === 0,
  );
}

/**
 * Why a leg has no route, naming both chains: what discovery found, then why
 * each channel this session ruled out for the leg was ruled out. "No channel"
 * alone would hide that the canonical one exists and its client expired.
 */
function noChannelWarnings(leg: Leg, tried: ReadonlyMap<string, LegWalk>): string[] {
  const [from, to] = leg;
  const lead = `No usable transfer channel from ${chainName(from)} to ${chainName(to)} is known`;
  const walked = tried.get(legKey(leg)) ?? walkedLegs.get(legKey(leg));
  const read = walked?.read ?? [];
  const summary = [
    read.length > 0 ? `${lead}, and reading ${channelLists(read)} turned up none.` : `${lead}.`,
    ...(walked?.failure ? [walked.failure] : []),
    "Enter the channel by hand if you know it.",
  ].join(" ");
  const refusals = [...channelChecks.keys()]
    .map((key) => cachedCheck(key))
    .filter(
      (check): check is ChannelHopCheck =>
        check !== undefined &&
        !check.usable &&
        check.sourceChainId === from &&
        check.destChainId === to,
    )
    .map((check) => check.message);
  return [summary, ...refusals];
}

/** "Osmosis's channel list", or "the channel lists of Osmosis and Noble". */
function channelLists(chainIds: readonly string[]): string {
  const names = chainIds.map(chainName);
  if (names.length === 1) return `${names[0]}'s channel list`;
  return `the channel lists of ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/* -------------------------------------------------------------------------- *
 * Views
 * -------------------------------------------------------------------------- */

function chainName(chainId: string): string {
  return findCatalogEntry(chainId)?.chainName ?? chainId;
}

function chainIcon(chainId: string): string | undefined {
  const entry = findCatalogEntry(chainId);
  return entry ? catalogIconFor(entry) : undefined;
}

function uiSource(
  source: ChannelLinkSource | undefined,
): "discovered" | "manual" | "seed" | undefined {
  if (source === undefined) return undefined;
  if (source === "verified") return "discovered";
  return source;
}

/**
 * Pair each hop with the channel it uses.
 *
 * `plan.hops` includes the swap hop, which moves no packet and has no channel;
 * `candidate.links` does not. Walking both with one cursor keeps them aligned
 * without assuming where the swap sits in the list.
 */
function hopViews(
  candidate: RoutePlanCandidate,
  confirmed: ReadonlySet<string>,
): RouteHopView[] {
  const views: RouteHopView[] = [];
  let linkIndex = 0;
  candidate.plan.hops.forEach((hop, index) => {
    const link = hop.kind === "swap" ? undefined : candidate.links[linkIndex];
    if (hop.kind !== "swap") linkIndex += 1;
    // Only an explicit `open`, from the cache or from this session's check on
    // both chains, counts. `undefined` and `unknown` both render as NOT
    // verified, which is the honest reading of "nobody checked".
    const open =
      link?.state === "open" || (link !== undefined && confirmed.has(linkCheckKey(link)));
    views.push({
      index,
      chainId: hop.chainId,
      chainName: chainName(hop.chainId),
      ...(chainIcon(hop.chainId) ? { chainIconUrl: chainIcon(hop.chainId) } : {}),
      counterpartyChainId: hop.counterpartyChainId,
      ...(hop.counterpartyChainId
        ? {
            counterpartyChainName: chainName(hop.counterpartyChainId),
            ...(chainIcon(hop.counterpartyChainId)
              ? { counterpartyChainIconUrl: chainIcon(hop.counterpartyChainId) }
              : {}),
          }
        : {}),
      channelId: hop.channelId,
      port: hop.port,
      kind: hop.kind,
      ...(link?.source ? { channelSource: uiSource(link.source) } : {}),
      channelVerified: open,
      ...(open
        ? { channelState: "open" as const }
        : link?.state
          ? { channelState: link.state }
          : {}),
    });
  });
  return views;
}

/**
 * Hop views for a path read straight off the channel directory, before any
 * plan exists: what Send shows as the automatic route while the recipient or
 * the amount is still missing.
 */
export function pathHopViews(links: readonly ChannelLink[]): RouteHopView[] {
  return links.map((link, index) => ({
    index,
    chainId: link.sourceChainId,
    chainName: chainName(link.sourceChainId),
    ...(chainIcon(link.sourceChainId) ? { chainIconUrl: chainIcon(link.sourceChainId) } : {}),
    counterpartyChainId: link.destChainId,
    counterpartyChainName: chainName(link.destChainId),
    ...(chainIcon(link.destChainId)
      ? { counterpartyChainIconUrl: chainIcon(link.destChainId) }
      : {}),
    channelId: link.channelId,
    port: link.port ?? TRANSFER_PORT,
    kind: index === 0 ? ("transfer" as const) : ("forward" as const),
    ...(link.source ? { channelSource: uiSource(link.source) } : {}),
    channelVerified: link.state === "open",
    ...(link.state ? { channelState: link.state } : {}),
  }));
}

/**
 * The one thing that must stop a signature.
 *
 * `intermediateReceiverFor` falls back to the literal string `"pfm"` when the
 * host supplied no address for an intermediate chain. That is a valid memo and
 * an invalid destination: the funds are addressed to a name, not an account.
 */
function blockedReasonFor(plan: RoutePlan, memo: MemoInspection): string | null {
  const placeholder = `"${PFM_INTERMEDIATE_RECEIVER}"`;
  if (plan.memo.includes(`"receiver":${placeholder}`)) {
    // Only the *final* receiver matters: PFM's convention is an invalid bech32
    // on intermediate hops, and the engine puts the real recipient on the last.
    if (memo.forward && memo.forward.finalReceiver === PFM_INTERMEDIATE_RECEIVER) {
      return "Zunia has no address for one of the chains on this route, so it cannot say where the funds end up.";
    }
  }
  if (memo.kind === "unknown") {
    return "Zunia could not read what this memo will do on arrival, so it will not ask you to sign it.";
  }
  return null;
}

function toView(candidate: RoutePlanCandidate, checked: PathCheck): RoutePlanView {
  const memo = validateMemo(candidate.plan.memo, { receiver: candidate.receiver });
  return {
    plan: candidate.plan,
    candidate,
    receiver: candidate.receiver,
    hops: hopViews(candidate, checked.confirmed),
    // The engine's own per-plan warnings, anything the memo classifier raised
    // (a `do_nothing` failure action, an over-long memo), and caveats from the
    // channel checks.
    warnings: [...candidate.plan.warnings, ...memo.warnings, ...checked.warnings],
    memo,
    blockedReason: blockedReasonFor(candidate.plan, memo) ?? checked.blockedReason,
    failedCheck: checked.failed,
  };
}

/* -------------------------------------------------------------------------- *
 * Planning
 * -------------------------------------------------------------------------- */

/** What the caller wants moved, and who it belongs to. */
export interface PlanInput {
  readonly sourceChainId: string;
  readonly destChainId: string;
  /** Denom as held on the source chain: `usafro` or `ibc/…`. */
  readonly inputDenom: string;
  /** Base units, decimal string. Never a number. */
  readonly amountBaseUnits: string;
  readonly sender: string;
  readonly recipient: string;
  readonly manualChannels?: readonly ManualChannel[];
  /**
   * Derives the wallet's own address on each chain, for the ICS20 receiver on
   * an intermediate hop. Injected because deriving needs the unlocked keyring,
   * which lives in the background worker and must not be reachable from here.
   */
  readonly resolveAddresses: (
    chainIds: readonly string[],
  ) => Promise<Readonly<Record<string, string>>>;
  readonly signal?: AbortSignal;
}

/** Extra inputs for the swap path. */
export interface SwapPlanInput extends PlanInput {
  /** Denom the user wants, as the *destination* chain names it. */
  readonly destDenom: string;
  readonly slippagePercent: number;
  /** `local_recovery_addr`: the wallet's own address on the venue chain. */
  readonly recoveryAddress: string;
  readonly venue: SwapVenue;
  /**
   * What the token the user sells is called on the venue, from its identity.
   *
   * The planner derives the venue denoms from the channels it routes over. When
   * this is set and the route names the input differently, the route would
   * sell another token that only shares a ticker (Injective USDC over Osmosis
   * channel-109 arrives as ibc/4AF5…, not ibc/794C…), and the swap is blocked
   * with `venue-denom-mismatch`. Omit it to skip the check.
   */
  readonly expectedVenueInputDenom?: string;
  /** The same for the token the user buys: its denom on the venue. */
  readonly expectedVenueOutputDenom?: string;
}

function overridesFrom(manual: readonly ManualChannel[] | undefined): RouteHopOverride[] {
  return (manual ?? []).map((entry) => ({
    fromChainId: entry.fromChainId,
    toChainId: entry.toChainId,
    channelId: entry.channelId,
    ...(entry.port ? { port: entry.port } : {}),
    ...(entry.counterpartyChannelId
      ? { counterpartyChannelId: entry.counterpartyChannelId }
      : {}),
  }));
}

/**
 * Probe the middlewares a candidate path depends on.
 *
 * A probe is evidence, not proof: a public node may hide the module's query
 * route. `undefined` therefore means "nobody could tell", which the planner
 * reports as unconfirmed rather than as unsupported.
 */
async function probeCapabilities(
  chainIds: readonly string[],
  venueChainId: string | null,
  signal: AbortSignal | undefined,
): Promise<Map<string, ChainCapabilities>> {
  const service = channelService();
  const out = new Map<string, ChainCapabilities>();
  const opts = signal ? { signal } : {};
  await Promise.all(
    chainIds.map(async (chainId) => {
      const [pfm, hooks] = await Promise.all([
        service.detectPfmSupport(chainId, opts).catch(() => null),
        chainId === venueChainId
          ? service.detectIbcHooksSupport(chainId, opts).catch(() => null)
          : Promise.resolve(null),
      ]);
      const caps: ChainCapabilities = {
        ...(pfm && pfm.status !== "unknown" ? { pfm: pfm.supported } : {}),
        ...(hooks && hooks.status !== "unknown" ? { ibcHooks: hooks.supported } : {}),
      };
      if (Object.keys(caps).length > 0) out.set(chainId, caps);
    }),
  );
  return out;
}

/** Chains a plan crosses, excluding the two the caller already knows about. */
function pathChainIds(candidate: RoutePlanCandidate): string[] {
  const ids = new Set<string>();
  for (const hop of candidate.plan.hops) {
    ids.add(hop.chainId);
    if (hop.counterpartyChainId) ids.add(hop.counterpartyChainId);
  }
  return [...ids];
}

interface PlanPassOptions {
  readonly allowSwap: boolean;
  readonly maxHops?: number;
  readonly outputDenom?: string;
  readonly slippagePercent?: number;
  readonly recoveryAddress?: string;
  readonly venues?: readonly SwapVenue[];
  readonly intermediateReceivers?: Readonly<Record<string, string>>;
  readonly capabilities?: Map<string, ChainCapabilities>;
}

async function runPlan(
  input: PlanInput,
  directory: ChannelDirectory,
  pass: PlanPassOptions,
) {
  const caps = pass.capabilities;
  return planRoute(
    {
      sourceChainId: input.sourceChainId,
      destChainId: input.destChainId,
      inputDenom: input.inputDenom,
      amount: input.amountBaseUnits,
      sender: input.sender,
      recipient: input.recipient,
      ...(pass.outputDenom ? { outputDenom: pass.outputDenom } : {}),
      ...(pass.slippagePercent === undefined
        ? {}
        : { slippagePercent: pass.slippagePercent }),
      ...(pass.recoveryAddress ? { recoveryAddress: pass.recoveryAddress } : {}),
      maxHops: pass.maxHops ?? MAX_ROUTE_HOPS,
      allowSwap: pass.allowSwap,
      allowPfm: true,
      timeoutMinutes: PACKET_TIMEOUT_MINUTES,
    },
    {
      registry: chainRegistry(),
      channels: directory,
      resolveDenom: routeDenomResolver(denomResolver()),
      ...(pass.venues ? { venues: pass.venues } : {}),
      ...(caps ? { capabilities: (chainId: string) => caps.get(chainId) } : {}),
    },
    {
      overrides: overridesFrom(input.manualChannels),
      ...(pass.intermediateReceivers
        ? { intermediateReceivers: pass.intermediateReceivers }
        : {}),
      ...(input.signal ? { lcdRequest: { signal: input.signal } } : {}),
    },
  );
}

/**
 * How many rounds of plan, check, plan again one request may take.
 *
 * Every round that asks for another has either ruled a channel out or
 * confirmed the chosen ones, so the next starts from more than the last. Five
 * leaves room for an expired canonical channel, its fallback, one discovery
 * and the confirming round.
 */
const MAX_PLAN_ROUNDS = 5;

const NO_SETTLED_ROUTE =
  "Zunia could not settle on a channel for this route, so it will not ask you to sign. Try again in a moment.";

/** One snapshot of the graph, planned for a same-asset transfer. */
async function routeTransfer(
  input: PlanInput,
  directory: ChannelDirectory,
): Promise<{
  best: RoutePlanCandidate | null;
  candidates: readonly RoutePlanCandidate[];
  warnings: readonly string[];
}> {
  const first = await runPlan(input, directory, { allowSwap: false, maxHops: 1 });
  if (!first.best) return { best: null, candidates: [], warnings: first.warnings };

  const chains = pathChainIds(first.best).filter(
    (id) => id !== input.sourceChainId && id !== input.destChainId,
  );
  if (chains.length === 0) {
    return { best: first.best, candidates: first.candidates, warnings: first.warnings };
  }

  const [receivers, capabilities] = await Promise.all([
    input.resolveAddresses(chains),
    probeCapabilities(chains, null, input.signal),
  ]);
  const second = await runPlan(input, directory, {
    allowSwap: false,
    maxHops: 1,
    intermediateReceivers: receivers,
    capabilities,
  });
  return second.best
    ? { best: second.best, candidates: second.candidates, warnings: second.warnings }
    : { best: first.best, candidates: first.candidates, warnings: first.warnings };
}

/**
 * Plan a same-asset cross-chain transfer.
 *
 * Plans twice on purpose. The first pass finds the path; only then do we know
 * which intermediate chains need one of the wallet's own addresses as the ICS20
 * receiver, and which chains to probe for packet-forward-middleware. The second
 * pass replans with both, so the memo that reaches the signing screen carries
 * real addresses rather than the `"pfm"` placeholder.
 *
 * Then every channel on the chosen path is checked on both chains. A channel
 * that fails is dropped and the transfer planned again; one the user pinned
 * blocks the plan with the reason. With no path at all, the channel lists are
 * read once per session (the source chain's, then the destination's when the
 * source names none; see {@link walkLeg}) and the transfer planned again.
 */
export async function planTransfer(input: PlanInput): Promise<TransferPlanResult> {
  try {
    const tried = new Map<string, LegWalk>();
    let result: TransferPlanResult | null = null;
    for (let round = 0; round < MAX_PLAN_ROUNDS; round += 1) {
      const directory = await channelDirectory();
      const routed = await routeTransfer(input, directory);
      if (!routed.best) {
        const legs = missingLegs(directory, [[input.sourceChainId, input.destChainId]], 1);
        if (await discoverLegs(legs, tried, input.signal)) continue;
        return {
          best: null,
          alternatives: [],
          warnings: [...legs.flatMap((leg) => noChannelWarnings(leg, tried)), ...routed.warnings],
          error: null,
        };
      }

      const checked = await checkPath(routed.best.links, input.manualChannels, input.signal);
      result = {
        best: toView(routed.best, checked),
        alternatives: routed.candidates
          .slice(1)
          .map((candidate) => toView(candidate, sessionPathCheck(candidate.links))),
        warnings: routed.warnings,
        error: null,
      };
      if (!planAgain(checked)) return result;
    }
    return result ?? { best: null, alternatives: [], warnings: [NO_SETTLED_ROUTE], error: null };
  } catch (error) {
    return {
      best: null,
      alternatives: [],
      warnings: [],
      error: describeInterchainError(error),
    };
  }
}

/* -------------------------------------------------------------------------- *
 * Swap
 * -------------------------------------------------------------------------- */

/**
 * The first channel the packet takes *out* of the swap venue.
 *
 * `candidate.links` is `[...inbound, ...outbound]` and `plan.hops` is the same
 * list with the swap hop spliced in, so the swap hop's index in `hops` is the
 * count of inbound links. `undefined` when the venue is the destination.
 */
function outboundLinkOf(candidate: RoutePlanCandidate): ChannelLink | undefined {
  const swapIndex = candidate.plan.hops.findIndex((hop) => hop.kind === "swap");
  if (swapIndex < 0) return undefined;
  return candidate.links[swapIndex];
}

/** The channel on the venue chain that receives from `destChainId`, if known. */
function venueLinkTo(
  directory: ChannelDirectory,
  venueChainId: string,
  destChainId: string,
): ChannelLink | undefined {
  return directory
    .from(venueChainId)
    .find((link) => link.destChainId === destChainId);
}

/**
 * Name the destination asset the way the venue chain names it.
 *
 * `output_denom` in the crosschain-swap message is a denom **on the venue**, so
 * "ATOM delivered on the Hub" has to become the Hub's token as Osmosis holds
 * it. `recommendDenom` does exactly that walk, including deciding that a token
 * which originally came *from* the venue unwinds rather than double-wraps, so
 * nothing here re-derives a trace.
 *
 * Returns `null` when it cannot be named, which disables the swap rather than
 * guessing a denom the pool has never heard of.
 */
async function venueDenomFor(
  chainId: string,
  denom: string,
  venueChainId: string,
  receiveChannelId: string | undefined,
  signal: AbortSignal | undefined,
): Promise<{ denom: string | null; warnings: readonly string[] }> {
  if (chainId === venueChainId) return { denom, warnings: [] };
  if (!receiveChannelId) {
    return {
      denom: null,
      warnings: [
        `No known channel from ${chainName(venueChainId)} to ${chainName(chainId)}, so the asset cannot be named on ${chainName(venueChainId)}.`,
      ],
    };
  }
  const recommendation = await denomResolver().recommendDenom(
    chainId,
    venueChainId,
    denom,
    {
      destinationReceiveChannelId: receiveChannelId,
      ...(signal ? { signal } : {}),
    },
  );
  return { denom: recommendation.outputDenom, warnings: recommendation.warnings };
}

/** A swap routed over one snapshot of the graph, before its channels are checked. */
type SwapRoute =
  | {
      readonly kind: "none";
      /** Legs with no path, which discovery may fill. */
      readonly missing: readonly Leg[];
      readonly warnings: readonly string[];
    }
  | {
      readonly kind: "planned";
      readonly candidate: RoutePlanCandidate;
      readonly candidates: readonly RoutePlanCandidate[];
      /** `output_denom` in the memo, computed against the candidate's outbound channel. */
      readonly outputDenom: string;
      readonly warnings: readonly string[];
    };

/**
 * Route a swap over one snapshot of the channel graph.
 *
 * The order is forced by the protocol: the memo's `output_denom` is a denom on
 * the venue chain, so the outbound channel has to be chosen before the route is
 * planned, and the inbound denom is only known once the route exists. Hence
 * pick outbound link, name the output, plan.
 */
async function routeSwap(
  input: SwapPlanInput,
  directory: ChannelDirectory,
  venueChainId: string,
): Promise<SwapRoute> {
  const warnings: string[] = [];

  // 1. The outbound leg, chosen here so the output denom and the plan agree
  //    on which channel the funds leave the venue by.
  const outLink =
    input.destChainId === venueChainId
      ? undefined
      : venueLinkTo(directory, venueChainId, input.destChainId);
  if (input.destChainId !== venueChainId && !outLink) {
    return { kind: "none", missing: [[venueChainId, input.destChainId]], warnings: [] };
  }

  // 2. The asset the user wants, as the venue names it.
  const output = await venueDenomFor(
    input.destChainId,
    input.destDenom,
    venueChainId,
    outLink?.channelId,
    input.signal,
  );
  warnings.push(...output.warnings);
  if (!output.denom) {
    return {
      kind: "none",
      missing: [],
      warnings: [
        ...warnings,
        `Zunia could not work out what ${input.destDenom} is called on ${chainName(venueChainId)}, so it will not put a guessed denom in the swap.`,
      ],
    };
  }

  // 3. Plan, then replan with the outbound channel the planner actually chose,
  //    real intermediate receivers, and probed modules.
  //
  //    The outbound channel is read back rather than pinned as an override:
  //    an override is recorded as `manual`, and labelling a channel the
  //    wallet picked as one the user entered is a lie the route panel would
  //    then repeat.
  const first = await runPlan(input, directory, {
    allowSwap: true,
    outputDenom: output.denom,
    slippagePercent: input.slippagePercent,
    recoveryAddress: input.recoveryAddress,
    venues: [input.venue],
  });
  if (!first.best) {
    return {
      kind: "none",
      missing: missingLegs(
        directory,
        [
          [input.sourceChainId, venueChainId],
          [venueChainId, input.destChainId],
        ],
        MAX_ROUTE_HOPS,
      ),
      warnings: [...warnings, ...first.warnings],
    };
  }

  // The planner may have taken a different channel out of the venue than the
  // one the provisional output denom was computed against, which would put a
  // denom the pool has never heard of in the memo. Recompute against its
  // choice before the plan that gets signed is built.
  let outputDenom = output.denom;
  const chosenOut = outboundLinkOf(first.best);
  if (chosenOut && chosenOut.channelId !== outLink?.channelId) {
    const revised = await venueDenomFor(
      input.destChainId,
      input.destDenom,
      venueChainId,
      chosenOut.channelId,
      input.signal,
    );
    warnings.push(...revised.warnings);
    if (!revised.denom) {
      return {
        kind: "none",
        missing: [],
        warnings: [
          ...warnings,
          `The route leaves ${chainName(venueChainId)} by ${chosenOut.channelId}, and Zunia could not name ${input.destDenom} for that channel.`,
        ],
      };
    }
    outputDenom = revised.denom;
  }

  const chains = pathChainIds(first.best).filter(
    (id) => id !== input.sourceChainId && id !== input.destChainId,
  );
  const [receivers, capabilities] = await Promise.all([
    chains.length > 0
      ? input.resolveAddresses(chains)
      : Promise.resolve({} as Record<string, string>),
    probeCapabilities(chains, venueChainId, input.signal),
  ]);
  const second = await runPlan(input, directory, {
    allowSwap: true,
    outputDenom,
    slippagePercent: input.slippagePercent,
    recoveryAddress: input.recoveryAddress,
    venues: [input.venue],
    intermediateReceivers: receivers,
    capabilities,
  });
  const candidate = second.best ?? first.best;

  // Last check before anything is offered for signing: the memo's
  // `output_denom` is only correct for the channel it was computed against.
  const finalOut = outboundLinkOf(candidate);
  const pricedAgainst = chosenOut?.channelId ?? outLink?.channelId;
  if (finalOut && pricedAgainst && finalOut.channelId !== pricedAgainst) {
    return {
      kind: "none",
      missing: [],
      warnings: [
        ...warnings,
        `The route out of ${chainName(venueChainId)} changed between planning passes (${pricedAgainst} then ${finalOut.channelId}), so the swap's output denom and its route no longer agree. Pick the channel by hand.`,
      ],
    };
  }

  return {
    kind: "planned",
    candidate,
    candidates: second.best ? second.candidates : first.candidates,
    outputDenom,
    warnings: [...warnings, ...(second.best ? second.warnings : first.warnings)],
  };
}

/**
 * Plan and price a cross-chain swap.
 *
 * Each round routes the swap over the current graph (see {@link routeSwap}) and
 * checks every channel on the chosen path on both chains. A channel that fails
 * is dropped and the swap routed again; one the user pinned blocks the plan.
 * A leg with no path at all is discovered once and the swap routed again.
 * Only a plan whose channels all passed is priced.
 */
export async function planSwap(input: SwapPlanInput): Promise<SwapPlanResult> {
  const empty: SwapPlanResult = {
    best: null,
    alternatives: [],
    warnings: [],
    error: null,
    quote: null,
    quoteBlockedReason: null,
    quoteBlockedCode: null,
    venueInputDenom: null,
    venueOutputDenom: null,
    venue: input.venue,
  };

  try {
    const venueChainId = input.venue.chainId;
    const tried = new Map<string, LegWalk>();
    let settled: { route: Extract<SwapRoute, { kind: "planned" }>; checked: PathCheck } | null =
      null;
    for (let round = 0; round < MAX_PLAN_ROUNDS; round += 1) {
      const directory = await channelDirectory();
      const route = await routeSwap(input, directory, venueChainId);
      if (route.kind === "none") {
        if (await discoverLegs(route.missing, tried, input.signal)) continue;
        return {
          ...empty,
          warnings: [
            ...route.missing.flatMap((leg) => noChannelWarnings(leg, tried)),
            ...route.warnings,
          ],
        };
      }
      const checked = await checkPath(route.candidate.links, input.manualChannels, input.signal);
      settled = { route, checked };
      if (!planAgain(checked)) break;
    }
    if (!settled) return { ...empty, warnings: [NO_SETTLED_ROUTE] };
    return await finishSwap(input, venueChainId, settled.route, settled.checked, empty);
  } catch (error) {
    return { ...empty, error: describeInterchainError(error) };
  }
}

/** Turn a routed, checked swap into the result, pricing it when it may be signed. */
async function finishSwap(
  input: SwapPlanInput,
  venueChainId: string,
  route: Extract<SwapRoute, { kind: "planned" }>,
  checked: PathCheck,
  empty: SwapPlanResult,
): Promise<SwapPlanResult> {
  const { candidate, outputDenom } = route;
  const view = toView(candidate, checked);
  const result: SwapPlanResult = {
    ...empty,
    best: view,
    alternatives: route.candidates
      .slice(1)
      .map((other) => toView(other, sessionPathCheck(other.links))),
    warnings: route.warnings,
  };

  // A channel that failed its check blocks the plan, and a price for a route
  // that cannot be signed would only invite a requote of it. The venue denoms
  // stay null for the same reason.
  if (!checked.ok) return { ...result, quoteBlockedReason: checked.blockedReason };

  // 4. Price it. Everything below is about the quote only; the route above is
  //    already correct and is shown even when the quote cannot be had.
  const swapIndex = candidate.plan.hops.findIndex((hop) => hop.kind === "swap");
  const inboundLinks =
    swapIndex < 0 ? candidate.links : candidate.links.slice(0, swapIndex);
  const lastInbound = inboundLinks[inboundLinks.length - 1];

  const priced = await priceSwap({
    candidate,
    inboundLinks,
    lastInbound,
    input,
    venueChainId,
    venueOutputDenom: outputDenom,
  });

  if (priced.code === "venue-denom-mismatch") {
    // Not just unpriced: signing this would trade another token, so the plan
    // itself is blocked, and no venue denom is handed back to requote with.
    return {
      ...result,
      best: { ...view, blockedReason: view.blockedReason ?? priced.blockedReason },
      quoteBlockedReason: priced.blockedReason,
      quoteBlockedCode: priced.code,
    };
  }
  return {
    ...result,
    quote: priced.quote,
    quoteBlockedReason: priced.blockedReason,
    quoteBlockedCode: priced.code,
    venueInputDenom: priced.venueInputDenom,
    venueOutputDenom: outputDenom,
  };
}

/**
 * Compare the route's venue denoms with the ones the caller expects.
 *
 * The caller knows which variant the user picked: its identity names the
 * token's denom on the venue. The planner derives the venue denoms from the
 * channels it chose. They differ when the route crosses another channel than
 * the identity assumes, and the contract would then trade a token that only
 * shares a ticker with the one on screen.
 */
function venueDenomMismatch(
  input: SwapPlanInput,
  venueChainId: string,
  inputDenom: string,
  outputDenom: string,
): string | null {
  const differences: string[] = [];
  const expectedIn = input.expectedVenueInputDenom;
  if (expectedIn && expectedIn !== inputDenom) {
    differences.push(`sells ${inputDenom}, not ${expectedIn}`);
  }
  const expectedOut = input.expectedVenueOutputDenom;
  if (expectedOut && expectedOut !== outputDenom) {
    differences.push(`buys ${outputDenom}, not ${expectedOut}`);
  }
  if (differences.length === 0) return null;
  return `Zunia would trade a different variant of the token than the one you picked: on ${chainName(venueChainId)} this route ${differences.join(" and ")}. The swap stays unsigned.`;
}

async function priceSwap(args: {
  candidate: RoutePlanCandidate;
  inboundLinks: readonly ChannelLink[];
  lastInbound: ChannelLink | undefined;
  input: SwapPlanInput;
  venueChainId: string;
  venueOutputDenom: string;
}): Promise<{
  quote: OsmosisSwapQuote | null;
  blockedReason: string | null;
  code: SwapQuoteBlockedCode | null;
  venueInputDenom: string | null;
}> {
  const { candidate, inboundLinks, lastInbound, input, venueChainId, venueOutputDenom } = args;

  // A venue-origin swap has no inbound packet. The input denom is already the
  // venue's name for the coin the user is about to hand the contract.
  if (!lastInbound && !candidate.venueInputDenom) {
    return {
      quote: null,
      venueInputDenom: null,
      code: null,
      blockedReason: "This route has no transfer into the swap venue, so there is nothing to price.",
    };
  }

  // The planner walks the token through every inbound hop, wraps and unwinds
  // included. A one-hop route can still ask `recommendDenom` when the planner
  // had no trace to work from.
  const venueInput =
    candidate.venueInputDenom !== null
      ? { denom: candidate.venueInputDenom }
      : inboundLinks.length === 1
        ? await venueDenomFor(
            input.sourceChainId,
            input.inputDenom,
            venueChainId,
            lastInbound?.counterpartyChannelId,
            input.signal,
          )
        : { denom: null };
  if (!venueInput.denom) {
    return {
      quote: null,
      venueInputDenom: null,
      code: null,
      blockedReason: `Zunia could not work out what this token is called on ${chainName(venueChainId)}${
        lastInbound?.counterpartyChannelId
          ? ""
          : lastInbound
            ? `, because the far end of ${lastInbound.channelId} is unknown`
            : ""
      }, so it will not price the swap.`,
    };
  }

  // The tokens on screen name both sides on the venue. A route that names
  // either side differently would trade something else, so it stops here.
  const mismatch = venueDenomMismatch(input, venueChainId, venueInput.denom, venueOutputDenom);
  if (mismatch) {
    return {
      quote: null,
      venueInputDenom: null,
      code: "venue-denom-mismatch",
      blockedReason: mismatch,
    };
  }

  if (venueInput.denom === venueOutputDenom) {
    return {
      quote: null,
      venueInputDenom: venueInput.denom,
      code: "same-token",
      blockedReason:
        "Both sides of this swap are the same token on the venue chain. Use a plain transfer instead.",
    };
  }

  const priced = await quoteOnVenue({
    venueChainId,
    venueContract: input.venue.contractAddress,
    venueInputDenom: venueInput.denom,
    venueOutputDenom,
    amountBaseUnits: input.amountBaseUnits,
    slippagePercent: input.slippagePercent,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return {
    quote: priced.quote,
    venueInputDenom: venueInput.denom,
    blockedReason: priced.error,
    code: priced.code,
  };
}

/** What to price on the venue, once the route has named both sides there. */
export interface VenueQuoteInput {
  readonly venueChainId: string;
  /** Crosschain-swaps contract the memo will call. Its route table is the one that executes. */
  readonly venueContract: string;
  readonly venueInputDenom: string;
  readonly venueOutputDenom: string;
  readonly amountBaseUnits: string;
  readonly slippagePercent: number;
  readonly signal?: AbortSignal;
}

/** A venue price, or why there is none. */
export interface VenueQuote {
  readonly quote: OsmosisSwapQuote | null;
  readonly error: string | null;
  /** Which known reason {@link error} is; `null` for the rest. */
  readonly code: SwapQuoteBlockedCode | null;
}

const NO_CONTRACT_ROUTE =
  "The Osmosis swap contract has no route for this pair. Signing would send the tokens, the packet would be rejected, and the funds would come back. The swap stays unsigned.";

const ROUTE_UNREADABLE =
  "Zunia could not confirm the Osmosis swap contract will accept this pair, so the swap stays unsigned.";

const ROUTE_UNPRICED =
  "The pools on the Osmosis swap contract's route for this pair could not be priced, so the swap stays unsigned.";

async function quoteOnVenue(args: VenueQuoteInput): Promise<VenueQuote> {
  const venueChain = chainRegistry().get(args.venueChainId);
  if (!venueChain) {
    return {
      quote: null,
      error: `${args.venueChainId} is not in this wallet's chain list.`,
      code: null,
    };
  }
  const lcd = lcdFor(venueChain);
  // SQS will price pairs this contract cannot execute. The deployed
  // crosschain-swaps build has no memo field for a route, so the only path
  // that can run is the one in the swaprouter table. Price that path, or
  // refuse the quote.
  let executable;
  try {
    executable = await readXcsExecutableRoute(
      lcd,
      args.venueContract,
      args.venueInputDenom,
      args.venueOutputDenom,
      {
        ...(args.signal ? { signal: args.signal } : {}),
        retries: 0,
        timeoutMs: 8_000,
        cacheTtlMs: 60_000,
      },
    );
  } catch (error) {
    return { quote: null, error: describeInterchainError(error), code: null };
  }
  if (executable.status === "missing") {
    return { quote: null, error: NO_CONTRACT_ROUTE, code: "no-contract-route" };
  }
  if (executable.status !== "ready") {
    return { quote: null, error: ROUTE_UNREADABLE, code: "route-unreadable" };
  }

  try {
    const quote = await quoteOsmosisSwap(
      {
        tokenInDenom: args.venueInputDenom,
        tokenInAmount: args.amountBaseUnits,
        tokenOutDenom: args.venueOutputDenom,
        slippagePercent: args.slippagePercent,
        router: swapRouterClient(),
        // The contract executes these pools and no others. Asking SQS for its
        // own best path showed a price for a swap the packet then rejected.
        route: executable.route,
        ...(args.signal ? { request: { signal: args.signal } } : {}),
      },
      lcd,
    );
    return { quote, error: null, code: null };
  } catch (error) {
    const unpriced = isInterchainError(error) && error.code === "no-route";
    return {
      quote: null,
      error: unpriced ? ROUTE_UNPRICED : describeInterchainError(error),
      code: unpriced ? "route-unpriced" : null,
    };
  }
}

/**
 * Price a planned swap again without planning it again.
 *
 * The memo carries a TWAP tolerance rather than a minimum output, so neither
 * the route nor the message the user signs depends on the price: a fresh quote
 * only changes what the user is shown before they sign.
 */
export function requoteSwap(args: VenueQuoteInput): Promise<VenueQuote> {
  return quoteOnVenue(args);
}

/** The tolerance the UI starts with, so screens do not each pick their own. */
export const INITIAL_SLIPPAGE_PERCENT = DEFAULT_SLIPPAGE_PERCENT;

/** The venue chain id, re-exported so screens need only one import. */
export const VENUE_CHAIN_ID = SWAP_VENUE_CHAIN_ID;

/* -------------------------------------------------------------------------- *
 * The one message the user signs
 * -------------------------------------------------------------------------- */

/**
 * The execute body of a venue-origin swap.
 *
 * The plan stores the same `{wasm:{contract,msg}}` object an inbound packet
 * would carry, so memo inspection stays one path. When the funds are already
 * on Osmosis the user signs that inner `msg` as `MsgExecuteContract` and
 * attaches the coins. Only `osmosis_swap` is accepted: a memo that asks for
 * any other contract call is not a swap this screen will sign.
 */
function venueSwapExecute(memo: string): { contract: string; msg: JsonObject } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(memo);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const wasm = (parsed as { wasm?: unknown }).wasm;
  if (wasm === null || typeof wasm !== "object" || Array.isArray(wasm)) return null;
  const contract = (wasm as { contract?: unknown }).contract;
  const msg = (wasm as { msg?: unknown }).msg;
  if (typeof contract !== "string" || contract.trim() === "") return null;
  if (msg === null || typeof msg !== "object" || Array.isArray(msg)) return null;
  const keys = Object.keys(msg);
  if (keys.length !== 1 || keys[0] !== "osmosis_swap") return null;
  return { contract, msg: msg as JsonObject };
}

/**
 * The one message a plan asks the user to sign.
 *
 * An inbound route is `/ibc.applications.transfer.v1.MsgTransfer`: the channel
 * from `hops[0]`, the receiver from the candidate (the crosschain-swaps
 * contract, because ibc-hooks only runs when the ICS20 receiver is `""` or
 * the contract), and the memo verbatim.
 *
 * A plan that starts with the swap itself has no packet to sign. It is one
 * `MsgExecuteContract` on the venue, with the input coin attached, and the
 * contract sends the result onward.
 */
export function buildTransferMsgFromPlan(args: {
  readonly view: RoutePlanView;
  readonly sender: string;
  readonly amountBaseUnits: string;
  readonly timeoutMinutes?: number;
}): BuiltMsg {
  const hop = args.view.plan.hops[0];
  const execute = hop?.kind === "swap" ? venueSwapExecute(args.view.plan.memo) : null;
  if (execute) {
    return buildExecuteContractMsg({
      sender: args.sender,
      contract: execute.contract,
      msg: execute.msg,
      funds: [{ denom: args.view.plan.inputDenom, amount: args.amountBaseUnits }],
    });
  }
  return buildPlanTransferMsg({
    plan: args.view.plan,
    receiver: args.view.receiver,
    sender: args.sender,
    amount: args.amountBaseUnits,
    timeoutMinutes: args.timeoutMinutes ?? PACKET_TIMEOUT_MINUTES,
  });
}
