import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POOL_PRICE_SOURCES } from "../../config/prices";
import { formatFiatPrice } from "../format";

const settings = { liveBalances: true, currency: "USD" };
vi.mock("../settings", () => ({ getSettings: async () => settings }));
vi.mock("../balances", () => ({ hasLiveBalancePermission: async () => true }));

const { poolSourceFor, getPrices, parsePoolQuote, priceableChainIds } = await import("../prices");

const OSMOSIS_LCD = "https://lcd-osmosis.keplr.app";
const SPOT = `${OSMOSIS_LCD}/osmosis/poolmanager/v2/pools/3600/prices`;
const TWAP = `${OSMOSIS_LCD}/osmosis/twap/v1beta1/ArithmeticTwap?pool_id=3600`;

let store: Record<string, unknown> = {};
let routes: Record<string, unknown> = {};
const calls: string[] = [];

beforeEach(() => {
  store = {};
  calls.length = 0;
  settings.currency = "USD";
  routes = {
    "https://api.coingecko.com/api/v3/coins/usd-coin": {
      market_data: { current_price: { usd: 0.9998, eur: 0.92 }, price_change_percentage_24h: 0.01 },
    },
    "https://api.coingecko.com/api/v3/coins/osmosis": {
      market_data: { current_price: { usd: 0.2, eur: 0.18 }, price_change_percentage_24h: 2 },
    },
    [SPOT]: { spot_price: "0.000202749040940238000000000000000000" },
    [TWAP]: { arithmetic_twap: "0.000284792120779832" },
  };
  vi.stubGlobal("browser", {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: store[key] }),
        set: async (value: Record<string, unknown>) => {
          store = { ...store, ...value };
        },
        remove: async () => undefined,
      },
    },
  });
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url);
    const route = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    if (!route) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(routes[route]), { status: 200 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SAF priced from its Osmosis pool, on chain", () => {
  it("names the Osmosis pool only for chains CoinGecko does not list", () => {
    expect(poolSourceFor("safrochain-1")).toMatchObject({ name: "Osmosis", pair: "SAF/USDC", poolId: "3600" });
    expect(poolSourceFor("osmosis-1", { "osmosis-1": POOL_PRICE_SOURCES["safrochain-1"]! })).toBeNull();
    expect(priceableChainIds(["safrochain-1", "unknown-chain"])).toEqual(["safrochain-1"]);
  });

  it("no exchange is asked for a price", () => {
    expect(JSON.stringify(POOL_PRICE_SOURCES)).not.toMatch(/coinstore/i);
  });

  it("reads the spot price, and the change against the TWAP a day ago", () => {
    const quote = parsePoolQuote({ spot_price: "0.0002" }, { arithmetic_twap: "0.00025" });
    expect(quote?.price).toBe(0.0002);
    expect(quote?.change24h).toBeCloseTo(-20, 9);
    // No TWAP: the price stands, and no change is invented.
    expect(parsePoolQuote({ spot_price: "0.0002" }, null)).toEqual({ price: 0.0002, change24h: 0 });
    for (const bad of [null, {}, { spot_price: "0" }, { spot_price: "x" }]) {
      expect(parsePoolQuote(bad, null)).toBeNull();
    }
  });

  it("prices SAF in USD through USDC, and says where the price comes from", async () => {
    const prices = await getPrices(["safrochain-1", "osmosis-1"]);
    expect(prices["safrochain-1"]?.price).toBeCloseTo(0.000202749040940238 * 0.9998, 15);
    expect(prices["safrochain-1"]?.change24h).toBeLessThan(0);
    expect(prices["safrochain-1"]?.source).toEqual({
      name: "Osmosis",
      pair: "SAF/USDC",
      url: "https://app.osmosis.zone/pool/3600",
    });
    // Aggregator prices stay as they were, without a source.
    expect(prices["osmosis-1"]).toEqual({ price: 0.2, change24h: 2 });
    expect(calls.some((url) => url.startsWith(SPOT) && url.includes("base_asset_denom=ibc%2FDBAA"))).toBe(true);
    expect(calls.some((url) => url.includes("coinstore"))).toBe(false);
  });

  it("converts to the user's currency, and leaves SAF unpriced when USDC cannot be converted", async () => {
    settings.currency = "EUR";
    expect((await getPrices(["safrochain-1"], { force: true }))["safrochain-1"]?.price).toBeCloseTo(
      0.000202749040940238 * 0.92,
      15,
    );

    // A failed read keeps the last good prices; start from an empty cache.
    store = {};
    delete routes["https://api.coingecko.com/api/v3/coins/usd-coin"];
    expect((await getPrices(["safrochain-1"], { force: true }))["safrochain-1"]).toBeUndefined();
    // In USD, USDC at par is the only safe assumption without its quote.
    settings.currency = "USD";
    expect((await getPrices(["safrochain-1"], { force: true }))["safrochain-1"]?.price).toBeCloseTo(
      0.000202749040940238,
      15,
    );
  });

  it("leaves SAF unpriced when the pool does not answer", async () => {
    store = {};
    delete routes[SPOT];
    const prices = await getPrices(["safrochain-1", "osmosis-1"], { force: true });
    expect(prices["safrochain-1"]).toBeUndefined();
    expect(prices["osmosis-1"]?.price).toBe(0.2);
  });
});

describe("formatFiatPrice", () => {
  it("keeps the digits a small price needs", () => {
    expect(formatFiatPrice(0.00028, "USD")).toBe("$0.00028");
    expect(formatFiatPrice(0.000280056, "USD")).toBe("$0.0002801");
    expect(formatFiatPrice(0.1234567, "EUR")).toBe("€0.1235");
    expect(formatFiatPrice(0, "USD")).toBe(formatFiatPrice(-1, "USD"));
  });
});
