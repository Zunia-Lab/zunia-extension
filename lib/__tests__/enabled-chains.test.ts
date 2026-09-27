import { afterEach, describe, expect, it, vi } from "vitest";

import { STORAGE_KEYS } from "../storage-keys";

vi.mock("../custom-chains", () => ({
  hydrateCustomChains: async () => [],
}));

import {
  DEFAULT_ENABLED_CHAIN_IDS,
  getEnabledChainIds,
  setEnabledChainIds,
} from "../enabled-chains";

const COSMOS = "cosmoshub-4";
const OSMOSIS = "osmosis-1";
const SAFRO = "safrochain-1";

function area(map: Map<string, unknown>) {
  return {
    get: async (keys?: string | string[] | null) => {
      const list =
        keys == null ? [...map.keys()] : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const key of list) if (map.has(key)) out[key] = map.get(key);
      return out;
    },
    set: async (patch: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(patch)) map.set(key, value);
    },
    remove: async (keys: string | string[]) => {
      for (const key of [keys].flat()) map.delete(key);
    },
  };
}

function installStorage(options: {
  accounts?: Array<{
    index: number;
    name: string;
    enabledChainIds?: string[];
  }>;
  active?: number;
  global?: string[];
}) {
  const local = new Map<string, unknown>();
  const session = new Map<string, unknown>();
  if (options.accounts) local.set(STORAGE_KEYS.accounts, options.accounts);
  if (options.global) local.set(STORAGE_KEYS.enabledChains, options.global);
  if (typeof options.active === "number") {
    session.set(STORAGE_KEYS.sessionActiveAccount, options.active);
  }
  vi.stubGlobal("browser", {
    storage: {
      local: area(local),
      session: area(session),
    },
  });
  return { local, session };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("per-account enabled chains", () => {
  it("reads the active account's list, not another account's", async () => {
    installStorage({
      active: 1,
      accounts: [
        { index: 0, name: "One", enabledChainIds: [COSMOS, OSMOSIS, SAFRO] },
        { index: 1, name: "Two", enabledChainIds: [COSMOS] },
      ],
    });
    await expect(getEnabledChainIds()).resolves.toEqual([COSMOS]);
  });

  it("writes only the active account", async () => {
    const { local } = installStorage({
      active: 0,
      accounts: [
        { index: 0, name: "One", enabledChainIds: [COSMOS] },
        { index: 1, name: "Two", enabledChainIds: [OSMOSIS] },
      ],
    });
    await setEnabledChainIds([COSMOS, SAFRO]);
    const accounts = local.get(STORAGE_KEYS.accounts) as Array<{
      index: number;
      enabledChainIds?: string[];
    }>;
    expect(accounts[0]?.enabledChainIds).toEqual([COSMOS, SAFRO]);
    expect(accounts[1]?.enabledChainIds).toEqual([OSMOSIS]);
  });

  it("migrates the legacy global list onto an account that has none", async () => {
    const { local } = installStorage({
      active: 0,
      global: [OSMOSIS],
      accounts: [{ index: 0, name: "One" }],
    });
    await expect(getEnabledChainIds()).resolves.toEqual([OSMOSIS]);
    const accounts = local.get(STORAGE_KEYS.accounts) as Array<{
      enabledChainIds?: string[];
    }>;
    expect(accounts[0]?.enabledChainIds).toEqual([OSMOSIS]);
  });

  it("falls back to the pinned defaults when nothing was stored", async () => {
    installStorage({
      active: 0,
      accounts: [{ index: 0, name: "One" }],
    });
    await expect(getEnabledChainIds()).resolves.toEqual([
      ...DEFAULT_ENABLED_CHAIN_IDS,
    ]);
  });
});
