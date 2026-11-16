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
  it("keeps the good row, and tries the network again on the next read", async () => {
    const balances = await load();
    await balances.getChainBalances([ACCOUNT]);
    bank.status = 500;
    const [failed] = await balances.getChainBalances([ACCOUNT], { force: true });
    expect(failed?.error).toBeUndefined();
    expect(nativeOf([failed!])).toBe("5000000");
    bank.status = 200;
    bank.uosmo = "2000000";
    // The failure was not cached as a fresh row: the next read is not served from it.
    expect(nativeOf(await balances.getChainBalances([ACCOUNT]))).toBe("2000000");
  });

  it("reports the failure when there is no earlier row to show", async () => {
    const balances = await load();
    bank.status = 500;
    const [failed] = await balances.getChainBalances([ACCOUNT], { force: true });
    expect(failed?.error).toBeTruthy();
  });
});
