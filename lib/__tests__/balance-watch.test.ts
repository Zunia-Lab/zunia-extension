import { describe, expect, it } from "vitest";

import type { ChainBalance } from "../balances";
import { balanceFingerprint, watchForChange } from "../balance-watch";

function row(available: string, tokens: Array<[string, string]> = [], error?: string): ChainBalance {
  return {
    chainId: "osmosis-1",
    available,
    staked: "0",
    rewards: "0",
    denom: "uosmo",
    decimals: 6,
    symbol: "OSMO",
    tokens: tokens.map(([denom, amount]) => ({
      denom,
      amount,
      kind: "other",
      symbol: denom,
      displayName: denom,
      decimals: 6,
    })),
    ...(error ? { error } : {}),
  };
}

describe("balanceFingerprint", () => {
  it("is the same for the same numbers whatever the row order", () => {
    expect(balanceFingerprint(row("5", [["a", "1"], ["b", "2"]]))).toBe(
      balanceFingerprint(row("5", [["b", "2"], ["a", "1"]])),
    );
  });

  it("changes with the native amount and with any token", () => {
    const base = balanceFingerprint(row("5", [["a", "1"]]));
    expect(balanceFingerprint(row("4", [["a", "1"]]))).not.toBe(base);
    expect(balanceFingerprint(row("5", [["a", "2"]]))).not.toBe(base);
    expect(balanceFingerprint(row("5", [["a", "1"], ["b", "1"]]))).not.toBe(base);
  });

  it("says nothing for a missing row or a failed read", () => {
    expect(balanceFingerprint(undefined)).toBeNull();
    expect(balanceFingerprint(row("0", [], "HTTP 500"))).toBeNull();
  });
});

describe("watchForChange", () => {
  /** A clock the fake wait moves, so no test sleeps. */
  function clock() {
    let t = 0;
    return {
      now: () => t,
      wait: async (ms: number) => {
        t += ms;
      },
    };
  }

  it("stops as soon as the balance differs from the baseline", async () => {
    const answers = ["a", "a", "b", "c"];
    let reads = 0;
    const end = await watchForChange({
      read: async () => answers[reads++]!,
      baseline: "a",
      settled: () => false,
      signal: new AbortController().signal,
      ...clock(),
    });
    expect(end).toBe("changed");
    expect(reads).toBe(3);
  });

  it("takes the first answer as the baseline when none was shown", async () => {
    const answers = ["a", "a", "b"];
    let reads = 0;
    const end = await watchForChange({
      read: async () => answers[reads++]!,
      baseline: null,
      settled: () => false,
      signal: new AbortController().signal,
      ...clock(),
    });
    expect(end).toBe("changed");
    expect(reads).toBe(3);
  });

  it("does not mistake a failed read for a change", async () => {
    const answers = [null, null, "a", "b"];
    let reads = 0;
    const end = await watchForChange({
      read: async () => answers[reads++] ?? null,
      baseline: "a",
      settled: () => false,
      signal: new AbortController().signal,
      ...clock(),
    });
    expect(end).toBe("changed");
    expect(reads).toBe(4);
  });

  it("stops when the tracker reports the route settled", async () => {
    let reads = 0;
    let polls = 0;
    const end = await watchForChange({
      read: async () => {
        reads++;
        return "a";
      },
      baseline: "a",
      settled: () => ++polls > 2,
      signal: new AbortController().signal,
      ...clock(),
    });
    expect(end).toBe("settled");
    expect(reads).toBe(2);
  });

  it("gives up after the time allowed, reading every interval", async () => {
    let reads = 0;
    const end = await watchForChange({
      read: async () => {
        reads++;
        return "a";
      },
      baseline: "a",
      settled: () => false,
      signal: new AbortController().signal,
      intervalMs: 10_000,
      maxMs: 180_000,
      ...clock(),
    });
    expect(end).toBe("timeout");
    expect(reads).toBe(18);
  });

  it("ends when the caller aborts, without another read", async () => {
    const controller = new AbortController();
    let reads = 0;
    const end = await watchForChange({
      read: async () => {
        reads++;
        return "a";
      },
      baseline: "a",
      settled: () => false,
      signal: controller.signal,
      now: () => 0,
      wait: async () => controller.abort(),
    });
    expect(end).toBe("aborted");
    expect(reads).toBe(0);
  });
});
