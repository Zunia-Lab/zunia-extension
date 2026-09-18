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
 * Nothing here signs or broadcasts. It is safe to run in the popup, and does,
 * so a long plan can be cancelled with an `AbortSignal` when the user edits the
 * form instead of blocking a background worker that MV3 may kill mid-flight.
 */

import {
  createChannelDirectory,
  planRoute,
  quoteOsmosisSwap,
  validateMemo,
  routeDenomResolver,
  PFM_INTERMEDIATE_RECEIVER,
  TRANSFER_PORT,
  isInterchainError,
  type BuiltMsg,
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
import {
  channelService,
  chainRegistry,
  denomResolver,
  describeInterchainError,
  loadRouteRegistry,
  lcdFor,
  saveRouteRegistry,
  swapRouterClient,
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
   * to a literal `"pfm"` and they are gone.
   */
  readonly blockedReason: string | null;
}

/** Result of planning a same-asset cross-chain transfer. */
export interface TransferPlanResult {
  readonly best: RoutePlanView | null;
  readonly alternatives: readonly RoutePlanView[];
  /** Planner-level notes: why some route was not offered at all. */
  readonly warnings: readonly string[];
  readonly error: string | null;
}

/** Result of planning a cross-chain swap, including its price. */
export interface SwapPlanResult extends TransferPlanResult {
  readonly quote: OsmosisSwapQuote | null;
  /** Why there is no quote, when there is none. Never `null` alongside a `null` quote and a plan. */
  readonly quoteBlockedReason: string | null;
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
  return {
    sourceChainId: route.sourceChainId,
    destChainId: route.destChainId,
    channelId: route.channelId,
    port: TRANSFER_PORT,
    ...(route.counterpartyChannelId
      ? { counterpartyChannelId: route.counterpartyChannelId }
      : {}),
    source: linkSourceOf(route),
    // `verifiedAt` is the only evidence we have that the channel was open. A
    // seed row carries 0 and must never render as open.
    state: route.verifiedAt > 0 ? "open" : "unknown",
  };
}

/** Everything the wallet currently believes about the channel graph. */
export async function channelDirectory(): Promise<ChannelDirectory> {
  const registry = await loadRouteRegistry();
  return createChannelDirectory(registry.list().map(routeToLink));
}

/**
 * Discover open transfer channels between two chains and remember them.
 *
 * Returns an empty list for the ordinary reasons — same chain, no endpoint,
 * live reads off, nothing matched — which the caller must present as "none
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
  const registry = await loadRouteRegistry();
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
  await saveRouteRegistry(registry);
  return found;
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
  options: { signal?: AbortSignal } = {},
): Promise<IbcChannelValidation> {
  return channelService().validateIbcChannel(sourceChainId, channelId, destChainId, {
    checkCounterparty: true,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/** Remember a channel the user entered, so the next plan can use it. */
export async function rememberManualChannel(input: ManualChannel): Promise<void> {
  const registry = await loadRouteRegistry();
  registry.put({
    sourceChainId: input.fromChainId,
    destChainId: input.toChainId,
    channelId: input.channelId,
    counterpartyChannelId: input.counterpartyChannelId ?? "",
    // Never claim the user's channel was verified: they told us, nobody checked.
    verifiedAt: 0,
    source: "manual",
  });
  await saveRouteRegistry(registry);
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
function hopViews(candidate: RoutePlanCandidate): RouteHopView[] {
  const views: RouteHopView[] = [];
  let linkIndex = 0;
  candidate.plan.hops.forEach((hop, index) => {
    const link = hop.kind === "swap" ? undefined : candidate.links[linkIndex];
    if (hop.kind !== "swap") linkIndex += 1;
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
      // Only an explicit `open` counts. `undefined` and `unknown` both render as
      // NOT verified, which is the honest reading of "nobody checked".
      channelVerified: link?.state === "open",
      ...(link?.state ? { channelState: link.state } : {}),
    });
  });
  return views;
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

function toView(candidate: RoutePlanCandidate): RoutePlanView {
  const memo = validateMemo(candidate.plan.memo, { receiver: candidate.receiver });
  return {
    plan: candidate.plan,
    candidate,
    receiver: candidate.receiver,
    hops: hopViews(candidate),
    // The engine's own per-plan warnings plus anything the memo classifier
    // raised (a `do_nothing` failure action, an over-long memo).
    warnings: [...candidate.plan.warnings, ...memo.warnings],
    memo,
    blockedReason: blockedReasonFor(candidate.plan, memo),
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
}

function overridesFrom(manual: readonly ManualChannel[] | undefined): RouteHopOverride[] {
  return (manual ?? []).map((entry) => ({
    fromChainId: entry.fromChainId,
    toChainId: entry.toChainId,
    channelId: entry.channelId,
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
      maxHops: MAX_ROUTE_HOPS,
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
 * Plan a same-asset cross-chain transfer.
 *
 * Runs twice on purpose. The first pass finds the path; only then do we know
 * which intermediate chains need one of the wallet's own addresses as the ICS20
 * receiver, and which chains to probe for packet-forward-middleware. The second
 * pass replans with both, so the memo that reaches the signing screen carries
 * real addresses rather than the `"pfm"` placeholder.
 */
export async function planTransfer(input: PlanInput): Promise<TransferPlanResult> {
  try {
    const directory = await channelDirectory();
    const first = await runPlan(input, directory, { allowSwap: false });
    if (!first.best) {
      return {
        best: null,
        alternatives: [],
        warnings: first.warnings,
        error: null,
      };
    }

    const chains = pathChainIds(first.best).filter(
      (id) => id !== input.sourceChainId && id !== input.destChainId,
    );
    if (chains.length === 0) {
      return {
        best: toView(first.best),
        alternatives: first.candidates.slice(1).map(toView),
        warnings: first.warnings,
        error: null,
      };
    }

    const [receivers, capabilities] = await Promise.all([
      input.resolveAddresses(chains),
      probeCapabilities(chains, null, input.signal),
    ]);
    const second = await runPlan(input, directory, {
      allowSwap: false,
      intermediateReceivers: receivers,
      capabilities,
    });
    const best = second.best ?? first.best;
    return {
      best: toView(best),
      alternatives: (second.best ? second.candidates : first.candidates)
        .slice(1)
        .map(toView),
      warnings: second.best ? second.warnings : first.warnings,
      error: null,
    };
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
 * it. `recommendDenom` does exactly that walk — including deciding that a token
 * which originally came *from* the venue unwinds rather than double-wraps — so
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

/**
 * Plan and price a cross-chain swap.
 *
 * The order is forced by the protocol: the memo's `output_denom` is a denom on
 * the venue chain, so the outbound channel has to be chosen before the route is
 * planned, and the inbound denom is only known once the route exists. Hence
 * pick outbound link, name the output, plan, then quote.
 */
export async function planSwap(input: SwapPlanInput): Promise<SwapPlanResult> {
  const empty: SwapPlanResult = {
    best: null,
    alternatives: [],
    warnings: [],
    error: null,
    quote: null,
    quoteBlockedReason: null,
    venueInputDenom: null,
    venueOutputDenom: null,
    venue: input.venue,
  };

  try {
    const venueChainId = input.venue.chainId;
    const directory = await channelDirectory();
    const warnings: string[] = [];

    // 1. The outbound leg, chosen here so the output denom and the plan agree
    //    on which channel the funds leave the venue by.
    const outLink =
      input.destChainId === venueChainId
        ? undefined
        : venueLinkTo(directory, venueChainId, input.destChainId);
    if (input.destChainId !== venueChainId && !outLink) {
      return {
        ...empty,
        warnings: [
          `No channel is known from ${chainName(venueChainId)} to ${chainName(input.destChainId)}. Run discovery or enter the channel by hand.`,
        ],
      };
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
        ...empty,
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
      return { ...empty, warnings: [...warnings, ...first.warnings] };
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
          ...empty,
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
        ...empty,
        warnings: [
          ...warnings,
          `The route out of ${chainName(venueChainId)} changed between planning passes (${pricedAgainst} then ${finalOut.channelId}), so the swap's output denom and its route no longer agree. Pick the channel by hand.`,
        ],
      };
    }

    const view = toView(candidate);
    const planWarnings = [...warnings, ...(second.best ? second.warnings : first.warnings)];

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

    return {
      best: view,
      alternatives: (second.best ? second.candidates : first.candidates)
        .slice(1)
        .map(toView),
      warnings: planWarnings,
      error: null,
      quote: priced.quote,
      quoteBlockedReason: priced.blockedReason,
      venueInputDenom: priced.venueInputDenom,
      venueOutputDenom: outputDenom,
      venue: input.venue,
    };
  } catch (error) {
    return { ...empty, error: describeInterchainError(error) };
  }
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
  venueInputDenom: string | null;
}> {
  const { inboundLinks, lastInbound, input, venueChainId, venueOutputDenom } = args;

  if (inboundLinks.length !== 1 || !lastInbound) {
    // ENGINE GAP: `planRoute` computes the denom arriving on the venue for a
    // forwarded inbound leg but does not expose it on the candidate, and
    // `recommendDenom` only models a single hop's wrap. Rather than re-deriving
    // the trace here — which is exactly the duplication this refactor removed —
    // the swap is refused with the reason shown to the user.
    return {
      quote: null,
      venueInputDenom: null,
      blockedReason:
        inboundLinks.length === 0
          ? "This route has no transfer into the swap venue, so there is nothing to price."
          : `Zunia cannot name the token that arrives on ${chainName(venueChainId)} after ${inboundLinks.length} hops, so it will not price this swap. Pick a source chain with a direct channel to ${chainName(venueChainId)}.`,
    };
  }

  const venueInput = await venueDenomFor(
    input.sourceChainId,
    input.inputDenom,
    venueChainId,
    lastInbound.counterpartyChannelId,
    input.signal,
  );
  if (!venueInput.denom) {
    return {
      quote: null,
      venueInputDenom: null,
      blockedReason: `Zunia could not work out what this token is called on ${chainName(venueChainId)}${
        lastInbound.counterpartyChannelId
          ? ""
          : `, because the far end of ${lastInbound.channelId} is unknown`
      }, so it will not price the swap.`,
    };
  }
  if (venueInput.denom === venueOutputDenom) {
    return {
      quote: null,
      venueInputDenom: venueInput.denom,
      blockedReason:
        "Both sides of this swap are the same token on the venue chain. Use a plain transfer instead.",
    };
  }

  const venueChain = chainRegistry().get(venueChainId);
  if (!venueChain) {
    return {
      quote: null,
      venueInputDenom: venueInput.denom,
      blockedReason: `${venueChainId} is not in this wallet's chain list.`,
    };
  }

  try {
    const quote = await quoteOsmosisSwap(
      {
        tokenInDenom: venueInput.denom,
        tokenInAmount: input.amountBaseUnits,
        tokenOutDenom: venueOutputDenom,
        slippagePercent: input.slippagePercent,
        router: swapRouterClient(),
        // One path rather than a split order: the crosschain-swap contract
        // executes a single route, so a split quote would price something the
        // memo cannot ask for.
        singleRoute: true,
        ...(input.signal ? { request: { signal: input.signal } } : {}),
      },
      lcdFor(venueChain),
    );
    return { quote, venueInputDenom: venueInput.denom, blockedReason: null };
  } catch (error) {
    const reason = isInterchainError(error) && error.code === "no-route"
      ? `${chainName(venueChainId)} has no pool for this pair, so the swap cannot be priced or executed.`
      : describeInterchainError(error);
    return { quote: null, venueInputDenom: venueInput.denom, blockedReason: reason };
  }
}

/** The tolerance the UI starts with, so screens do not each pick their own. */
export const INITIAL_SLIPPAGE_PERCENT = DEFAULT_SLIPPAGE_PERCENT;

/** The venue chain id, re-exported so screens need only one import. */
export const VENUE_CHAIN_ID = SWAP_VENUE_CHAIN_ID;

/* -------------------------------------------------------------------------- *
 * The one message the user signs
 * -------------------------------------------------------------------------- */

/**
 * `/ibc.applications.transfer.v1.MsgTransfer` for a plan.
 *
 * ENGINE GAP: `@zunialab/interchain` builds the plan and the memo but has no
 * ICS20 message builder — it exports `buildNftTransferMsg` and
 * `buildIcs721TransferMsg` for CosmWasm messages and nothing for a transfer.
 * The proto-JSON below is the shape `zunia-core`'s `msg_from_proto_json`
 * parses, and it is written once, here, so no screen assembles it by hand.
 *
 * Every field comes off the plan: the channel from `hops[0]`, the receiver from
 * the candidate (which is the crosschain-swaps contract for a swap, because
 * ibc-hooks only runs when the ICS20 receiver is `""` or the contract), and the
 * memo verbatim.
 */
export function buildTransferMsgFromPlan(args: {
  readonly view: RoutePlanView;
  readonly sender: string;
  readonly amountBaseUnits: string;
  readonly timeoutMinutes?: number;
}): BuiltMsg {
  const hop = args.view.plan.hops[0];
  if (!hop || hop.kind === "swap") {
    throw new Error("This plan has no transfer for the user to sign");
  }
  const minutes = args.timeoutMinutes ?? PACKET_TIMEOUT_MINUTES;
  // Nanoseconds since the epoch. A packet with neither a height nor a timestamp
  // never expires, and its escrow is never refunded, so the kernel refuses one.
  const timeoutTimestamp = (
    BigInt(Date.now()) * 1_000_000n +
    BigInt(minutes) * 60n * 1_000_000_000n
  ).toString();

  return {
    typeUrl: "/ibc.applications.transfer.v1.MsgTransfer",
    value: {
      source_port: hop.port || TRANSFER_PORT,
      source_channel: hop.channelId,
      token: { denom: args.view.plan.inputDenom, amount: args.amountBaseUnits },
      sender: args.sender,
      receiver: args.view.receiver,
      // Explicit zero height: the timeout is the timestamp above.
      timeout_height: { revision_number: "0", revision_height: "0" },
      timeout_timestamp: timeoutTimestamp,
      memo: args.view.plan.memo,
    },
  };
}
