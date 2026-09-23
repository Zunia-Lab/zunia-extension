/**
 * Following a signed route across every hop, and getting money back when the
 * last hop fails.
 *
 * All of the work is `trackRoute` in `@zunialab/interchain`: it reads the
 * transaction the user signed, walks the packets forward, and decides which of
 * the four failure modes applies. This module supplies the LCD resolver and
 * turns the result into the props `PacketTracker` renders.
 *
 * Every read here is a public query. Tracking needs no key and no unlock, so it
 * keeps working after the wallet auto-locks mid-transfer — which is exactly
 * when a user most wants to see where their funds are.
 */

import {
  buildXcsRecoverMsg,
  getPacketStatus,
  isTerminalPacketStatus,
  trackRoute,
  type BuiltMsg,
  type ExtractedPacket,
  type PacketFailureKind,
  type PacketStatus,
  type RoutePlan,
  type RouteTrace,
} from "@zunialab/interchain";

import { catalogIconFor, findCatalogEntry } from "./chain-catalog";
import { channelService, describeInterchainError, lcdResolver } from "./interchain";

/** One hop, in the shape `PacketTracker` takes. */
export interface TrackedHopView {
  readonly chainId: string;
  readonly chainName: string;
  readonly chainIconUrl?: string;
  readonly counterpartyChainId: string | null;
  readonly counterpartyChainName?: string;
  readonly channelId?: string;
  readonly port?: string;
  readonly sequence?: string | null;
  readonly sendTxHash?: string | null;
  readonly receiveTxHash?: string | null;
  readonly status: PacketStatus;
  readonly error?: string | null;
  readonly stalled?: boolean;
}

/** Everything the tracking panel needs for one poll. */
export interface TrackedRoute {
  readonly hops: readonly TrackedHopView[];
  readonly status: TrackedHopView["status"];
  readonly failure: PacketFailureKind | null;
  readonly stalled: boolean;
  readonly currentHopIndex: number;
  readonly estimatedDurationSeconds: number;
  readonly elapsedSeconds: number | null;
  readonly updatedAt: number;
  /** True once nothing more will change without user action. */
  readonly settled: boolean;
  /**
   * A recover message, when the swap ran but delivery failed and the contract
   * address is configured. `null` means the funds are recoverable in principle
   * but this build cannot build the message, which the UI must say rather than
   * offering a dead button.
   */
  readonly recovery: {
    readonly chainId: string;
    readonly recoveryAddress: string | null;
    readonly contractAddress: string | null;
    readonly msg: BuiltMsg | null;
  } | null;
  /** Diagnostics from the walk. Developer-facing; never rendered raw. */
  readonly notes: readonly string[];
}

function chainName(chainId: string): string {
  return findCatalogEntry(chainId)?.chainName ?? chainId;
}

/** Display names and icon added to the hop fields the engine reports. */
function hopView(hop: {
  readonly chainId: string;
  readonly counterpartyChainId: string | null;
  readonly channelId: string;
  readonly port: string;
  readonly sequence: string | null;
  readonly sendTxHash: string | null;
  readonly receiveTxHash: string | null;
  readonly status: PacketStatus;
  readonly error: string | null;
  readonly stalled?: boolean;
}): TrackedHopView {
  const entry = findCatalogEntry(hop.chainId);
  const icon = entry ? catalogIconFor(entry) : undefined;
  return {
    chainId: hop.chainId,
    chainName: chainName(hop.chainId),
    ...(icon ? { chainIconUrl: icon } : {}),
    counterpartyChainId: hop.counterpartyChainId,
    ...(hop.counterpartyChainId
      ? { counterpartyChainName: chainName(hop.counterpartyChainId) }
      : {}),
    channelId: hop.channelId,
    port: hop.port,
    sequence: hop.sequence,
    sendTxHash: hop.sendTxHash,
    receiveTxHash: hop.receiveTxHash,
    status: hop.status,
    error: hop.error,
    ...(hop.stalled === undefined ? {} : { stalled: hop.stalled }),
  };
}

function toView(trace: RouteTrace): TrackedRoute {
  // `stalled` is the engine's, decided against a per-hop-kind threshold.
  // Recomputing it from a clock here would disagree with the engine on a swap.
  const hops = trace.hops.map((hop) => hopView(hop));

  return {
    hops,
    status: trace.status,
    failure: trace.failure,
    stalled: trace.stalled,
    currentHopIndex: trace.currentHopIndex,
    estimatedDurationSeconds: trace.estimatedDurationSeconds,
    elapsedSeconds: trace.elapsedSeconds,
    updatedAt: trace.updatedAt,
    // A stalled hop is still deliverable once a relayer picks it up, so it is
    // not settled: polling continues and the route stays in the pending list.
    settled:
      (trace.failure !== null && trace.failure !== "stalled") ||
      (isTerminalPacketStatus(trace.status) && trace.status !== "unknown"),
    recovery: trace.recovery
      ? {
          chainId: trace.recovery.chainId,
          recoveryAddress: trace.recovery.recoveryAddress,
          contractAddress: trace.recovery.contractAddress,
          msg: trace.recovery.msg,
        }
      : null,
    notes: trace.notes,
  };
}

/** Inputs for one tracking poll. */
export interface TrackInput {
  readonly plan: RoutePlan;
  readonly sourceTxHash: string;
  /** Base units moved, so a batched relayer transaction can be told apart. */
  readonly expectedAmount?: string;
  /** Crosschain-swaps contract, for the recovery message. Host config. */
  readonly swapContract?: string;
  /** The `local_recovery_addr` the swap was built with. */
  readonly recoveryAddress?: string;
  readonly signal?: AbortSignal;
  /** Called after each hop resolves, so a slow walk renders progressively. */
  readonly onUpdate?: (route: TrackedRoute) => void;
}

/** One poll of a signed route. Throws only for reasons the UI must show. */
export async function trackTransfer(input: TrackInput): Promise<TrackedRoute> {
  const trace = await trackRoute(input.plan, input.sourceTxHash, lcdResolver(), {
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.expectedAmount ? { expectedAmount: input.expectedAmount } : {}),
    ...(input.swapContract ? { swapContract: input.swapContract } : {}),
    ...(input.recoveryAddress ? { recoveryAddress: input.recoveryAddress } : {}),
    // A short TTL: polling with the default cache would show the same hop
    // status for the whole cache window and read as a stall that is not there.
    request: { cacheTtlMs: 2_000 },
    ...(input.onUpdate ? { onUpdate: (trace) => input.onUpdate?.(toView(trace)) } : {}),
  });
  return toView(trace);
}

/**
 * The `{"recover":{}}` message that pulls stuck swap output out of the
 * contract.
 *
 * Only the `local_recovery_addr` the swap declared can call it, and it must be
 * broadcast on the venue chain, not on the chain the user started from.
 */
export function buildRecoverMsg(input: {
  contractAddress: string;
  recoveryAddress: string;
}): BuiltMsg {
  return buildXcsRecoverMsg(input);
}

/** One sentence for a tracking failure, keyed off the engine's own code. */
export function describeTrackingError(error: unknown): string {
  return describeInterchainError(error);
}

/* -------------------------------------------------------------------------- *
 * Outcomes
 * -------------------------------------------------------------------------- */

export type RouteOutcome = "delivered" | "refunded" | "recoverable";

/**
 * The last hop has delivered, so the funds are on the destination chain. The
 * acknowledgement may still be on its way back to the source, but a packet
 * that was received can no longer time out.
 */
export function hasArrived(route: Pick<TrackedRoute, "failure" | "hops">): boolean {
  if (route.failure !== null && route.failure !== "stalled") return false;
  const last = route.hops[route.hops.length - 1];
  return last?.status === "received" || last?.status === "acknowledged";
}

/**
 * What a route means for the funds, or `null` while it can still move.
 *
 * A timeout and an error acknowledgement both release the escrow back to the
 * sender. A swap whose output could not be delivered is different: the
 * contract holds it until the recovery address claims it.
 */
export function routeOutcome(route: TrackedRoute): RouteOutcome | null {
  if (hasArrived(route)) return "delivered";
  if (!route.settled) return null;
  return route.failure === "swap-delivery-failed" ? "recoverable" : "refunded";
}

/* -------------------------------------------------------------------------- *
 * Packets of a past transaction
 * -------------------------------------------------------------------------- */

/** Where the packets of one transaction went, read without a route plan. */
export interface PacketWalk {
  readonly hops: readonly TrackedHopView[];
  readonly failure: PacketFailureKind | null;
  /** True once no hop can change any more. */
  readonly settled: boolean;
  readonly updatedAt: number;
}

/** A wallet-built transfer sends one packet; a batch is cut off here. */
const MAX_WALK_PACKETS = 3;
/** Forwards followed past each packet's first hop. */
const MAX_WALK_FORWARDS = 3;

/**
 * The channel a packet-forward memo sends the packet on next, or `null` when
 * the memo does not forward it.
 */
export function forwardChannelOf(memo: string | null | undefined): string | null {
  if (!memo) return null;
  try {
    const parsed = JSON.parse(memo) as { forward?: { channel?: unknown } } | null;
    const channel = parsed?.forward?.channel;
    return typeof channel === "string" && channel.length > 0 ? channel : null;
  } catch {
    return null;
  }
}

/**
 * Follow the packets a transaction sent, for one the wallet kept no plan for:
 * anything opened from the history.
 *
 * Each packet's first hop is always read. A packet whose memo asks
 * packet-forward-middleware to send it on is followed across each forward,
 * matched on the memo's channel and then the amount. A contract call such as
 * a swap is not followed, because what it sends next is not in the packet.
 */
export async function walkSentPackets(input: {
  readonly chainId: string;
  readonly txHash: string;
  readonly packets: readonly ExtractedPacket[];
  readonly signal?: AbortSignal;
}): Promise<PacketWalk> {
  const resolve = lcdResolver();
  const signal = input.signal ? { signal: input.signal } : {};
  const hops: TrackedHopView[] = [];
  let failure: PacketFailureKind | null = null;
  let open = false;

  for (const root of input.packets.slice(0, MAX_WALK_PACKETS)) {
    let chainId = input.chainId;
    let channelId = root.sourceChannelId;
    let port = root.sourcePort;
    let packet: ExtractedPacket | null = root;
    let sendTxHash: string | null = input.txHash;

    for (let depth = 0; depth <= MAX_WALK_FORWARDS; depth++) {
      const channel = await channelService().validateIbcChannel(
        chainId,
        channelId,
        undefined,
        signal,
      );
      const counterpartyChainId = channel.counterpartyChainId ?? null;
      const base = { chainId, counterpartyChainId, channelId, port };
      const source = resolve(chainId);
      if (packet === null || source === null) {
        // The forward has not left yet, or this chain cannot be read.
        hops.push(
          hopView({
            ...base,
            sequence: null,
            sendTxHash,
            receiveTxHash: null,
            status: packet === null ? "pending" : "unknown",
            error: null,
          }),
        );
        open = true;
        break;
      }

      const report = await getPacketStatus(
        packet,
        {
          source,
          destination: counterpartyChainId ? resolve(counterpartyChainId) : null,
        },
        { ...signal, request: { cacheTtlMs: 2_000 } },
      );
      hops.push(
        hopView({
          ...base,
          sequence: packet.sequence,
          sendTxHash,
          receiveTxHash: report.receiveTxHash,
          status: report.status,
          error: report.error,
        }),
      );
      if (report.failure !== null) {
        failure ??= report.failure;
        break;
      }
      if (!isTerminalPacketStatus(report.status)) open = true;

      const nextChannel = forwardChannelOf(packet.data?.memo);
      // A forward from a chain the wallet cannot read cannot be followed.
      if (nextChannel === null || counterpartyChainId === null) break;
      if (resolve(counterpartyChainId) === null) break;
      const amount: string | null = packet.data?.amount ?? null;
      const onward = report.onwardPackets.filter(
        (candidate) => candidate.sourceChannelId === nextChannel,
      );
      const next: ExtractedPacket | null =
        onward.length === 1
          ? (onward[0] ?? null)
          : (onward.find((candidate) => candidate.data?.amount === amount) ?? null);
      chainId = counterpartyChainId;
      channelId = nextChannel;
      port = next?.sourcePort ?? "transfer";
      sendTxHash = report.receiveTxHash;
      packet = next;
    }
  }

  return { hops, failure, settled: failure !== null || !open, updatedAt: Date.now() };
}
