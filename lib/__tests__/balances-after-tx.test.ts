import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * What the balance cache serves right after a transaction: the worker's
 * minute-long cache must not hold a screen on the numbers from before it, and
 * a read that fails while a screen is polling must not blank the row.
 */

const OSMO_ADDRESS = "osmo1holder000000000000000000000000000000000";
const ACCOUNT = { chainId: "osmosis-1", address: OSMO_ADDRESS };
const REST = "https://lcd-osmosis.keplr.app";

let store: Map<string, unknown>;
/** What the fake bank endpoint answers, changed between reads. */
let bank: { status: number; uosmo: string };
let bankReads: number;

async function load() {
  vi.resetModules();
  bankReads = 0;
  bank = { status: 200, uosmo: "5000000" };
  store = new Map<string, unknown>([["zunia.settings", { liveBalances: true }]]);
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.origin !== REST) throw new Error(`unexpected request to ${url.href}`);
    if (/^\/cosmos\/bank\/v1beta1\/balances\/[^/]+$/.test(url.pathname)) {
      bankReads++;
      if (bank.status !== 200) return new Response("{}", { status: bank.status });
      return new Response(
        JSON.stringify({ balances: [{ denom: "uosmo", amount: bank.uosmo }], pagination: { next_key: null } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("{}", { status: 501 });
  });
  vi.stubGlobal("browser", {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: store.get(key) }),
        set: async (patch: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(patch)) store.set(key, value);
        },
        remove: async (key: string) => void store.delete(key),
      },
      onChanged: { addListener: () => undefined },
    },
    permissions: { contains: async () => true },
  });
  return import("../balances");
}

const nativeOf = (rows: Array<{ tokens: Array<{ denom: string; amount: string }> }>) =>
  rows[0]?.tokens.find((token) => token.denom === "uosmo")?.amount;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the balance cache after a transaction", () => {
  it("serves the cached row inside its minute", async () => {
    const balances = await load();
    expect(nativeOf(await balances.getChainBalances([ACCOUNT]))).toBe("5000000");
    bank.uosmo = "4000000";
    expect(nativeOf(await balances.getChainBalances([ACCOUNT]))).toBe("5000000");
    expect(bankReads).toBe(1);
  });

  it("reads the network again for a chain whose rows were expired", async () => {
    const balances = await load();
    await balances.getChainBalances([ACCOUNT]);
    bank.uosmo = "4000000";
    await balances.expireChainBalances(["osmosis-1"]);
    expect(nativeOf(await balances.getChainBalances([ACCOUNT]))).toBe("4000000");
    expect(bankReads).toBe(2);
  });

  it("leaves the rows of other chains alone", async () => {
    const balances = await load();
    await balances.getChainBalances([ACCOUNT]);
    await balances.expireChainBalances(["cosmoshub-4"]);
    await balances.getChainBalances([ACCOUNT]);
    expect(bankReads).toBe(1);
  });

  it("always reads a forced read from the network and keeps the cache current", async () => {
    const balances = await load();
    await balances.getChainBalances([ACCOUNT]);
    bank.uosmo = "3000000";
    expect(nativeOf(await balances.getChainBalances([ACCOUNT], { force: true }))).toBe("3000000");
    // The next unforced read, within the minute, serves what the forced one stored.
    expect(nativeOf(await balances.getChainBalances([ACCOUNT]))).toBe("3000000");
    expect(bankReads).toBe(2);
  });
});

describe("a read that fails while a good row is held", () => {
  const MINUTE = 60_000;

  async function loadAt(start: number) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start);
    return load();
  }

  it("serves a young good row, flagged with why and when it was read", async () => {
    const balances = await loadAt(1_000_000);
    await balances.getChainBalances([ACCOUNT]);
    vi.setSystemTime(1_000_000 + 2 * MINUTE);
    bank.status = 500;
    const [served] = await balances.getChainBalances([ACCOUNT]);
    expect(served?.error).toBeUndefined();
    expect(served?.refreshError).toBeTruthy();
    expect(served?.readAt).toBe(1_000_000);
    expect(nativeOf([served!])).toBe("5000000");
  });

  it("serves the error row once the good row is older than ten minutes", async () => {
    const balances = await loadAt(1_000_000);
    await balances.getChainBalances([ACCOUNT]);
    vi.setSystemTime(1_000_000 + 11 * MINUTE);
    bank.status = 500;
    const [failed] = await balances.getChainBalances([ACCOUNT]);
    expect(failed?.error).toBeTruthy();
    expect(failed?.refreshError).toBeUndefined();
  });

  it("clears the flag with the next good read", async () => {
    const balances = await loadAt(1_000_000);
    await balances.getChainBalances([ACCOUNT]);
    vi.setSystemTime(1_000_000 + 2 * MINUTE);
    bank.status = 500;
    await balances.getChainBalances([ACCOUNT]);
    bank.status = 200;
    bank.uosmo = "2000000";
    vi.setSystemTime(1_000_000 + 2 * MINUTE + 16_000);
    const [fresh] = await balances.getChainBalances([ACCOUNT]);
    expect(fresh?.refreshError).toBeUndefined();
    expect(fresh?.readAt).toBeUndefined();
    expect(nativeOf([fresh!])).toBe("2000000");
  });

  it("does not ask a failing node again for 15 s, then does", async () => {
    const balances = await loadAt(1_000_000);
    await balances.getChainBalances([ACCOUNT]);
    vi.setSystemTime(1_000_000 + 2 * MINUTE);
    bank.status = 500;
    await balances.getChainBalances([ACCOUNT]);
    const afterFailure = bankReads;
    vi.setSystemTime(1_000_000 + 2 * MINUTE + 10_000);
    const [held] = await balances.getChainBalances([ACCOUNT]);
    expect(bankReads).toBe(afterFailure);
    expect(held?.refreshError).toBeTruthy();
    vi.setSystemTime(1_000_000 + 2 * MINUTE + 16_000);
    await balances.getChainBalances([ACCOUNT]);
    expect(bankReads).toBe(afterFailure + 1);
  });

  it("still reads at once after a transaction expired a flagged row", async () => {
    const balances = await loadAt(1_000_000);
    await balances.getChainBalances([ACCOUNT]);
    vi.setSystemTime(1_000_000 + 2 * MINUTE);
    bank.status = 500;
    await balances.getChainBalances([ACCOUNT]);
    const afterFailure = bankReads;
    bank.status = 200;
    bank.uosmo = "1000000";
    await balances.expireChainBalances(["osmosis-1"]);
    const [fresh] = await balances.getChainBalances([ACCOUNT]);
    expect(bankReads).toBe(afterFailure + 1);
    expect(nativeOf([fresh!])).toBe("1000000");
    expect(fresh?.refreshError).toBeUndefined();
  });

  it("reports the failure when there is no earlier row to show", async () => {
    const balances = await load();
    bank.status = 500;
    const [failed] = await balances.getChainBalances([ACCOUNT], { force: true });
    expect(failed?.error).toBeTruthy();
  });
});
