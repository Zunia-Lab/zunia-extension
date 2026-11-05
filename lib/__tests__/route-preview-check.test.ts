import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChannelHopCheck, RouteHopView } from "../route-plan";
import {
  hopsToCheck,
  previewHopKey,
  previewStatus,
  resetPreviewChecks,
  runPreviewChecks,
  sessionPreviewChecks,
  withPreviewChecks,
} from "../route-preview-check";

const hop = (channelId: string, extra: Partial<RouteHopView> = {}): RouteHopView => ({
  index: 0,
  chainId: "safrochain-1",
  chainName: "Safrochain",
  counterpartyChainId: "osmosis-1",
  counterpartyChainName: "Osmosis",
  channelId,
  port: "transfer",
  kind: "transfer",
  channelSource: "seed",
  ...extra,
});

const answer = (usable: boolean, verdict: string): ChannelHopCheck =>
  ({ usable, verdict, message: "", warning: null, checkedAt: 0 }) as unknown as ChannelHopCheck;

describe("the bridge route, checked before any amount", () => {
  beforeEach(() => resetPreviewChecks());

  it("is neutral while the chains are asked, never unchecked or refused", () => {
    const shown = withPreviewChecks([hop("channel-1")], new Map(), true);
    expect(shown[0]).toMatchObject({ channelChecking: true });
    expect(shown[0]?.channelVerified).toBeUndefined();
    expect(shown[0]?.channelRefused).toBeUndefined();
  });

  it("reads open once both chains agree, and keeps that for the session", async () => {
    const check = vi.fn(async () => answer(true, "active"));
    const settled = await runPreviewChecks([hop("channel-1")], { check: check as never });
    expect(settled.get("safrochain-1>osmosis-1:transfer/channel-1")).toBe("verified");
    expect(withPreviewChecks([hop("channel-1")], settled, false)[0]).toMatchObject({ channelVerified: true });
    // Typing an amount, or coming back, asks nothing again.
    await runPreviewChecks([hop("channel-1")], { check: check as never });
    expect(check).toHaveBeenCalledTimes(1);
    expect(sessionPreviewChecks().get("safrochain-1>osmosis-1:transfer/channel-1")).toBe("verified");
  });

  it("says refused only when the chains answered no, and asks again after an inconclusive answer", async () => {
    const refused = await runPreviewChecks([hop("channel-9")], { check: (async () => answer(false, "closed")) as never });
    expect(previewStatus(hop("channel-9"), refused, false)).toBe("refused");
    const unsure = await runPreviewChecks([hop("channel-7")], { check: (async () => answer(false, "inconclusive")) as never });
    expect(previewStatus(hop("channel-7"), unsure, false)).toBeNull();
    expect(hopsToCheck([hop("channel-7")], unsure)).toHaveLength(1);
  });

  it("leaves a hop unanswered when the check could not run", async () => {
    const settled = await runPreviewChecks([hop("channel-3")], {
      check: (async () => {
        throw new Error("reads off");
      }) as never,
    });
    expect(settled.has("safrochain-1>osmosis-1:transfer/channel-3")).toBe(false);
  });

  it("has nothing to ask about a hop with no channel, or one already confirmed", () => {
    expect(previewHopKey(hop(""))).toBeNull();
    expect(hopsToCheck([hop(""), hop("channel-1", { channelVerified: true })], new Map())).toEqual([]);
    expect(previewStatus(hop("channel-1", { channelVerified: true }), new Map(), true)).toBe("verified");
  });
});
