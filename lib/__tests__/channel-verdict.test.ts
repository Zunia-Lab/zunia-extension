import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHANNEL_MESSAGES,
  type CounterpartyCheck,
  type IbcChannelValidation,
} from "@zunialab/interchain";
import { classifyChannelCheck, verdictAllowsUse } from "../channel-verdict";

const DEST = "osmosis-1";

function check(overrides: Partial<IbcChannelValidation>): IbcChannelValidation {
  return {
    ok: true,
    state: "open",
    channelId: "channel-141",
    portId: "transfer",
    counterpartyChannelId: "channel-0",
    counterpartyChainId: DEST,
    message: `Open, connected to ${DEST}`,
    ...overrides,
  };
}

function farSide(overrides: Partial<CounterpartyCheck>): CounterpartyCheck {
  return {
    status: "ok",
    ok: true,
    chainId: DEST,
    channelId: "channel-0",
    portId: "transfer",
    state: "open",
    pointsBackTo: "channel-141",
    message: `Confirmed on ${DEST}`,
    ...overrides,
  };
}

describe("classifyChannelCheck", () => {
  it("verifies a channel the far side confirms", () => {
    const verdict = classifyChannelCheck(check({ counterparty: farSide({}) }), DEST);
    expect(verdict).toEqual({
      kind: "verified",
      note: `Confirmed on ${DEST}`,
      counterpartyChannelId: "channel-0",
    });
    expect(verdictAllowsUse(verdict)).toBe(true);
  });

  it("does not verify on the source chain's word alone", () => {
    const verdict = classifyChannelCheck(
      check({ counterparty: farSide({ status: "unreachable", ok: false, state: "unknown" }) }),
      DEST,
    );
    expect(verdict.kind).toBe("open-unconfirmed");
    expect(verdict.note).toContain("could not be asked");
    expect(verdictAllowsUse(verdict)).toBe(true);
  });

  it("says so when nothing named the far chain", () => {
    const verdict = classifyChannelCheck(
      check({ counterpartyChainId: null, message: DEFAULT_CHANNEL_MESSAGES.open }),
      DEST,
    );
    expect(verdict.kind).toBe("open-unconfirmed");
    expect(verdict.note).toContain(`nothing confirmed that it leads to ${DEST}`);
  });

  it("does not take a far side on another chain as confirmation", () => {
    const verdict = classifyChannelCheck(
      check({ counterparty: farSide({ chainId: "juno-1" }) }),
      DEST,
    );
    expect(verdict.kind).toBe("open-unconfirmed");
  });

  it("rejects a channel the chain does not know", () => {
    const verdict = classifyChannelCheck(
      check({ ok: false, state: "unknown", message: DEFAULT_CHANNEL_MESSAGES.notFound }),
      DEST,
    );
    expect(verdict.kind).toBe("rejected");
    expect(verdictAllowsUse(verdict)).toBe(false);
  });

  it("rejects an empty entry", () => {
    const verdict = classifyChannelCheck(
      check({ ok: false, state: "unknown", message: DEFAULT_CHANNEL_MESSAGES.emptyInput }),
      DEST,
    );
    expect(verdict.kind).toBe("rejected");
  });

  it("rejects a closed channel, a wrong chain, and a far side that disagrees", () => {
    for (const failed of [
      check({ ok: false, state: "closed", message: "Channel is closed" }),
      check({ ok: false, counterpartyChainId: "juno-1", message: "Connected to juno-1" }),
      check({
        ok: false,
        message: "Points somewhere else",
        counterparty: farSide({ status: "mismatch", ok: false, pointsBackTo: "channel-9" }),
      }),
    ]) {
      expect(classifyChannelCheck(failed, DEST).kind).toBe("rejected");
    }
  });

  it("calls an unreachable chain inconclusive, not wrong", () => {
    for (const message of [
      DEFAULT_CHANNEL_MESSAGES.unreachable,
      DEFAULT_CHANNEL_MESSAGES.noEndpoint,
      DEFAULT_CHANNEL_MESSAGES.readsDisabled,
    ]) {
      const verdict = classifyChannelCheck(check({ ok: false, state: "unknown", message }), DEST);
      expect(verdict.kind).toBe("inconclusive");
      expect(verdict.note).toContain("Nothing confirmed this channel");
      expect(verdictAllowsUse(verdict)).toBe(true);
    }
  });

  it("leaves the counterparty id out when the chain did not give one", () => {
    const verdict = classifyChannelCheck(
      check({ counterpartyChannelId: "", counterparty: farSide({}) }),
      DEST,
    );
    expect(verdict).not.toHaveProperty("counterpartyChannelId");
  });
});
