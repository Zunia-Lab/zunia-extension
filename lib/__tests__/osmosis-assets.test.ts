import { InterchainError, type LcdClient } from "@zunialab/interchain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OSMOSIS_ASSETS_CACHE_VERSION,
  listOsmosisAssets,
  osmosisSwapAssets,
  parseOsmosisTokenMetadata,
} from "../osmosis-assets";
import sqs from "./fixtures/swap/sqs-tokens-metadata.json";

const ATOM = "ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2";
const USDC_INJ = "ibc/794C7D7F3B857713878A3A1927251FA6AC1EEE520424C1F6FAFE9BA26D476138";
const USDC_N = "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4";
const USDC_AXL = "ibc/D189335C6E4A68B513C10AB227BF1C1D38C746766278BA3EEB4FB14124F1D858";
const ALL_USDC = "factory/osmo147h5x9pcj7lm0cttlaefx6sqq5vdfnmwfcqxkmjd7exqm9gc7grqhr75m0/alloyed/allUSDC";

describe("parseOsmosisTokenMetadata", () => {
  it("keeps listed tokens keyed by denom, sorted by symbol", () => {
    const assets = parseOsmosisTokenMetadata({
      uosmo: { name: "Osmosis", symbol: "OSMO", decimals: 6, preview: false, coingeckoId: "osmosis" },
      [ATOM]: { name: "Cosmos Hub", symbol: "ATOM", decimals: 6, preview: false, coingeckoId: "" },
    });
    expect(assets).toEqual([
      { denom: ATOM, symbol: "ATOM", name: "Cosmos Hub", decimals: 6, coinGeckoId: null },
      { denom: "uosmo", symbol: "OSMO", name: "Osmosis", decimals: 6, coinGeckoId: "osmosis" },
    ]);
  });

  it("drops preview tokens and rows that do not parse", () => {
    const assets = parseOsmosisTokenMetadata({
      "factory/osmo1x/new": { symbol: "NEW", decimals: 6, preview: true },
      "factory/osmo1x/unflagged": { symbol: "UNF", decimals: 6 },
      "1bad": { symbol: "BAD", decimals: 6, preview: false },
      unamed: { symbol: "", decimals: 6, preview: false },
      ufrac: { symbol: "FRAC", decimals: 6.5, preview: false },
      uhuge: { symbol: "HUGE", decimals: 99, preview: false },
      ustr: { symbol: "STR", decimals: "6", preview: false },
      unull: null,
    });
    expect(assets).toEqual([]);
  });

  it("falls back to the symbol for a missing name and bounds long text", () => {
    const [short, long] = parseOsmosisTokenMetadata({
      ushort: { symbol: "A", decimals: 18, preview: false, coingeckoId: "Not An Id" },
      ulong: { symbol: "X".repeat(40), name: "Y".repeat(90), decimals: 6, preview: false },
    });
    expect(short?.name).toBe("A");
    expect(short?.coinGeckoId).toBeNull();
    expect(long?.symbol).toHaveLength(24);
    expect(long?.name).toHaveLength(48);
  });

  it("answers an unexpected body with an empty list", () => {
    expect(parseOsmosisTokenMetadata(null)).toEqual([]);
    expect(parseOsmosisTokenMetadata([{ symbol: "OSMO" }])).toEqual([]);
    expect(parseOsmosisTokenMetadata("tokens")).toEqual([]);
  });
});

describe("osmosisSwapAssets", () => {
  const listed = parseOsmosisTokenMetadata(sqs);

  it("keeps the table's verified, stable rows that SQS still lists, and nothing else", () => {
    const assets = osmosisSwapAssets(listed);
    expect(assets).toHaveLength(106);
    for (const asset of assets) {
      expect(asset.row.denom).toBe(asset.denom);
      expect(asset.row.verified && asset.row.stable).toBe(true);
    }
    // 131 fixture rows: 106 proven, 4 previews, and 21 the old list offered.
    const offered = new Set(assets.map((asset) => asset.denom));
    const dropped = listed.filter((listing) => !offered.has(listing.denom)).map((listing) => listing.symbol);
    expect(dropped).toHaveLength(21);
    expect(dropped).toEqual(
      expect.arrayContaining(["OSMO-USDC-LP", "USDC-USDC.axl-LP", "earnUSDC", "nUSDC", "USDC.eth.wh", "USDC.avax.axl"]),
    );
  });

  it("offers four USDC on Osmosis: allUSDC, Noble's, Injective's and Axelar's", () => {
    const usdc = osmosisSwapAssets(listed)
      .filter((asset) => asset.row.family === "USDC")
      .map((asset) => asset.denom)
      .sort();
    expect(usdc).toEqual([ALL_USDC, USDC_N, USDC_INJ, USDC_AXL].sort());
  });

  it("drops a row SQS no longer lists", () => {
    const assets = osmosisSwapAssets(listed.filter((listing) => listing.denom !== USDC_INJ));
    expect(assets.some((asset) => asset.denom === USDC_INJ)).toBe(false);
    expect(assets).toHaveLength(105);
  });
});

describe("listOsmosisAssets", () => {
  let stored: Map<string, unknown>;

  beforeEach(() => {
    stored = new Map();
    vi.stubGlobal("browser", {
      storage: {
        session: {
          get: async (key: string) => ({ [key]: stored.get(key) }),
          set: async (patch: Record<string, unknown>) => {
            for (const [key, value] of Object.entries(patch)) stored.set(key, value);
          },
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function router(): LcdClient & { calls: number } {
    const client = {
      chainId: "osmosis-sqs-router",
      calls: 0,
      async getJson(path: string) {
        client.calls += 1;
        if (path !== "/tokens/metadata") throw new InterchainError("lcd-unreachable", path);
        return sqs;
      },
    };
    return client;
  }

  const down: LcdClient = {
    chainId: "osmosis-sqs-router",
    getJson: async () => {
      throw new InterchainError("lcd-unreachable", "router down");
    },
  };

  it("caches the listing with a version, and the cached copy keeps every field", async () => {
    const live = router();
    const fresh = await listOsmosisAssets({ router: live, now: 1_000 });
    expect(fresh).toHaveLength(106);
    expect(live.calls).toBe(1);
    const record = stored.get("zunia.osmosisAssets") as {
      version: number;
      fetchedAt: number;
      assets: { denom: string; coinGeckoId: string | null }[];
    };
    expect(record.version).toBe(OSMOSIS_ASSETS_CACHE_VERSION);
    expect(record.fetchedAt).toBe(1_000);
    expect(record.assets.find((row) => row.denom === USDC_INJ)?.coinGeckoId).toBe("usd-coin");

    const cached = await listOsmosisAssets({ router: down, now: 2_000 });
    expect(cached).toEqual(fresh);
    expect(cached.find((asset) => asset.denom === USDC_INJ)).toMatchObject({
      symbol: "USDC.inj",
      decimals: 6,
      coinGeckoId: "usd-coin",
      row: { originChainId: "injective-1", originDenom: "erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a" },
    });
  });

  it("ignores a 0.1.2 record, which had no version, and an expired one", async () => {
    stored.set("zunia.osmosisAssets", {
      fetchedAt: 1_000,
      assets: [{ denom: USDC_INJ, symbol: "USDC.inj", name: "USDC (Injective)", decimals: 6 }],
    });
    const live = router();
    expect(await listOsmosisAssets({ router: live, now: 2_000 })).toHaveLength(106);
    expect(live.calls).toBe(1);

    const later = 2_000 + 6 * 60 * 60 * 1000 + 1;
    await expect(listOsmosisAssets({ router: down, now: later })).rejects.toMatchObject({ code: "lcd-unreachable" });
  });
});
