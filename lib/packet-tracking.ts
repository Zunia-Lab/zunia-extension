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
  isTerminalPacketStatus,
  trackRoute,
  type BuiltMsg,
  type PacketFailureKind,
  type RoutePlan,
  type RouteTrace,
} from "@zunialab/interchain";

import { catalogIconFor, findCatalogEntry } from "./chain-catalog";
import { describeInterchainError, lcdResolver } from "./interchain";

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
  readonly status:
    | "pending"
    | "relayed"
    | "received"
    | "acknowledged"
    | "timeout"
    | "failed"
    | "unknown";
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

function toView(trace: RouteTrace): TrackedRoute {
  const hops = trace.hops.map((hop): TrackedHopView => {
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
      // The engine decides this against a per-hop-kind threshold. Recomputing
      // it from a clock here would disagree with the engine on a swap hop.
      stalled: hop.stalled,
    };
  });

  return {
    hops,
    status: trace.status,
    failure: trace.failure,
    stalled: trace.stalled,
    currentHopIndex: trace.currentHopIndex,
    estimatedDurationSeconds: trace.estimatedDurationSeconds,
    elapsedSeconds: trace.elapsedSeconds,
    updatedAt: trace.updatedAt,
    settled:
      trace.failure !== null ||
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
