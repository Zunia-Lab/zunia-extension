/**
 * What a channel check means for the user who typed the channel.
 *
 * The engine's `validateIbcChannel` answers in chain terms (state, counterparty
 * status, a message). Send needs one decision: may this channel carry the
 * transfer, and what must the review screen say about it. Kept pure so every
 * branch is tested without a network.
 */

import {
  DEFAULT_CHANNEL_MESSAGES,
  type IbcChannelValidation,
} from "@zunialab/interchain";

export type ChannelVerdictKind =
  /** Open on both chains, and the far side points back at it. */
  | "verified"
  /** Open on the source chain, but the far side did not confirm it. */
  | "open-unconfirmed"
  /** The chain could not be asked (endpoint down, reads off). Proves nothing. */
  | "inconclusive"
  /** A definite no: missing, not open, or connected somewhere else. */
  | "rejected";

export interface ChannelVerdict {
  readonly kind: ChannelVerdictKind;
  /** One sentence for the user, from the chain's own answer where possible. */
  readonly note: string;
  readonly counterpartyChannelId?: string;
}

export function classifyChannelCheck(
  check: IbcChannelValidation,
  destChainId: string,
): ChannelVerdict {
  const counterpartyChannelId = check.counterpartyChannelId || undefined;
  const withCounterparty = counterpartyChannelId ? { counterpartyChannelId } : {};

  if (!check.ok) {
    // Not open, wrong chain, and a far side that is missing, closed, or points
    // elsewhere all carry the state the source chain reported.
    const definite =
      check.state !== "unknown" ||
      check.message === DEFAULT_CHANNEL_MESSAGES.notFound ||
      check.message === DEFAULT_CHANNEL_MESSAGES.emptyInput;
    return definite
      ? { kind: "rejected", note: check.message }
      : {
          kind: "inconclusive",
          note: `${check.message}. Nothing confirmed this channel.`,
        };
  }

  // Only the far side itself can say it is open and points back; the source
  // chain's client naming the destination is half of that.
  const farSide = check.counterparty;
  if (farSide?.status === "ok" && (farSide.chainId ?? destChainId) === destChainId) {
    return { kind: "verified", note: farSide.message || check.message, ...withCounterparty };
  }
  return {
    kind: "open-unconfirmed",
    note:
      check.counterpartyChainId === destChainId
        ? `Open here and pointing at ${destChainId}, but ${destChainId} could not be asked to confirm it.`
        : `Open on this chain, but nothing confirmed that it leads to ${destChainId}.`,
    ...withCounterparty,
  };
}

/** A definite no is the only verdict that blocks the channel outright. */
export function verdictAllowsUse(verdict: ChannelVerdict): boolean {
  return verdict.kind !== "rejected";
}
