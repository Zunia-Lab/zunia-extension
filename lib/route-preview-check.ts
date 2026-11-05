/**
 * The channels of a route checked as soon as both networks are known, before
 * any amount: the same check a plan runs (lib/route-plan.ts `checkChannelHop`:
 * open on both chains, each side naming the other, light clients active).
 *
 * Without it the route preview showed every cached channel as "not checked"
 * until an amount was typed, and only then as open: a warning about nothing.
 * While the check runs the hop reads as being checked, which is neutral; a
 * hop reads as refused only once the chains have answered no.
 *
 * Answers are kept for the session per channel, so changing the amount, or
 * leaving the screen and coming back, never resets a channel to unchecked.
 * An answer that could not be had (a slow endpoint) is not kept.
 */

import { checkChannelHop, type ChannelHopCheck, type RouteHopView } from "./route-plan";

/** What the preview says about one hop's channel. */
export type PreviewCheckStatus = "checking" | "verified" | "refused" | "inconclusive";

/** Settled answers by {@link previewHopKey}. */
export type PreviewChecks = ReadonlyMap<string, Exclude<PreviewCheckStatus, "checking">>;

/** The channel a hop crosses, as a session key; `null` for a hop with nothing to check. */
export function previewHopKey(
  hop: Pick<RouteHopView, "chainId" | "counterpartyChainId" | "channelId" | "port" | "kind">,
): string | null {
  if (hop.kind === "swap" || !hop.counterpartyChainId || !hop.channelId) return null;
  return `${hop.chainId}>${hop.counterpartyChainId}:${hop.port || "transfer"}/${hop.channelId}`;
}

/** The answer a check comes to, in the preview's terms. */
export function statusOfCheck(check: Pick<ChannelHopCheck, "usable" | "verdict">): Exclude<PreviewCheckStatus, "checking"> {
  if (check.usable) return "verified";
  return check.verdict === "inconclusive" ? "inconclusive" : "refused";
}

/** The hops that still need asking: a channel to check, not already confirmed, not already answered. */
export function hopsToCheck(hops: readonly RouteHopView[], settled: PreviewChecks): RouteHopView[] {
  return hops.filter((hop) => {
    const key = previewHopKey(hop);
    if (key === null || hop.channelVerified) return false;
    const answer = settled.get(key);
    return answer === undefined || answer === "inconclusive";
  });
}

/**
 * What a hop shows: a settled answer, or `checking` while the check for it
 * runs (`active`), or nothing to add when there is no channel to check, the
 * hop is already confirmed, or nothing is running.
 */
export function previewStatus(
  hop: RouteHopView,
  settled: PreviewChecks,
  active: boolean,
): PreviewCheckStatus | null {
  const key = previewHopKey(hop);
  if (key === null) return null;
  if (hop.channelVerified) return "verified";
  const answer = settled.get(key);
  if (answer && answer !== "inconclusive") return answer;
  if (active) return "checking";
  return answer ?? null;
}

/** The hops with what the checks found laid over them, for the route rows. */
export function withPreviewChecks(
  hops: readonly RouteHopView[],
  settled: PreviewChecks,
  active: boolean,
): RouteHopView[] {
  return hops.map((hop) => {
    const status = previewStatus(hop, settled, active);
    if (status === "verified") return { ...hop, channelVerified: true, channelState: "open" as const };
    if (status === "checking") return { ...hop, channelChecking: true };
    if (status === "refused") return { ...hop, channelRefused: true };
    return hop;
  });
}

const session = new Map<string, Exclude<PreviewCheckStatus, "checking">>();

/** The answers this session already has. */
export function sessionPreviewChecks(): PreviewChecks {
  return new Map(session);
}

/** Forget the session's answers (tests). */
export function resetPreviewChecks(): void {
  session.clear();
}

/**
 * Ask the chains about every hop that still needs it, in parallel, and keep
 * each definite answer for the session. Resolves with all the answers this
 * session has. A check that throws (reads off, aborted) leaves its hop
 * unanswered rather than refused.
 */
export async function runPreviewChecks(
  hops: readonly RouteHopView[],
  options: {
    readonly signal?: AbortSignal;
    /** The check; `checkChannelHop` unless a test passes its own. */
    readonly check?: typeof checkChannelHop;
  } = {},
): Promise<PreviewChecks> {
  const check = options.check ?? checkChannelHop;
  const todo = hopsToCheck(hops, session);
  await Promise.all(
    todo.map(async (hop) => {
      const key = previewHopKey(hop);
      if (key === null || !hop.counterpartyChainId) return;
      try {
        const answer = await check(hop.chainId, hop.counterpartyChainId, hop.channelId, {
          portId: hop.port || "transfer",
          ...(options.signal ? { signal: options.signal } : {}),
        });
        const status = statusOfCheck(answer);
        if (status === "inconclusive") session.delete(key);
        else session.set(key, status);
      } catch {
        // Aborted, or reads turned off: nothing was learned about the channel.
      }
    }),
  );
  return new Map(session);
}
