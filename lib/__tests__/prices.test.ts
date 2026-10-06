import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXCHANGE_PRICE_SOURCES } from "../../config/prices";
import { formatFiatPrice } from "../format";

const settings = { liveBalances: true, currency: "USD" };
vi.mock("../settings", () => ({ getSettings: async () => settings }));
vi.mock("../balances", () => ({ hasLiveBalancePermission: async () => true }));

const { exchangeSourceFor, getPrices, parseCoinstoreKlines, priceableChainIds } = await import("../prices");

/** 24 hourly bars as Coinstore returns them: oldest open 0.000309, newest close 0.00028. */
function klines(closes: number[] = Array.from({ length: 24 }, (_, i) => (i === 23 ? 0.00028 : 0.0003))) {
  return {
    code: 0,
    data: {
      channel: "1938@kline@hour_1",
      item: closes.map((close, i) => ({
        startTime: 1791230400 + i * 3600,
        open: String(i === 0 ? 0.000309 : 0.0003),
        close: String(close),
        high: "0.00031",
        low: "0.000261",
        volume: "1000",
      })),
    },
  };
}

let store: Record<string, unknown> = {};
let routes: Record<string, unknown> = {};
const calls: string[] = [];

beforeEach(() => {
  store = {};
  calls.length = 0;
  settings.currency = "USD";
  routes = {
    "https://api.coingecko.com/api/v3/coins/tether": {
      market_data: { current_price: { usd: 1.0002, eur: 0.92 }, price_change_percentage_24h: 0.01 },
    },
    "https://api.coingecko.com/api/v3/coins/osmosis": {
      market_data: { current_price: { usd: 0.2, eur: 0.18 }, price_change_percentage_24h: 2 },
    },
    "https://api.coinstore.com/api/v1/market/kline/SAFUSDT": klines(),
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

describe("SAF priced from Coinstore's SAF/USDT market", () => {
  it("names Coinstore only for chains CoinGecko does not list", () => {
    expect(exchangeSourceFor("safrochain-1")).toMatchObject({ name: "Coinstore", pair: "SAF/USDT", market: "SAFUSDT" });
    expect(exchangeSourceFor("osmosis-1", { "osmosis-1": EXCHANGE_PRICE_SOURCES["safrochain-1"]! })).toBeNull();
    expect(priceableChainIds(["safrochain-1", "unknown-chain"])).toEqual(["safrochain-1"]);
  });

  it("reads the last price and the 24h change from the hourly bars", () => {
    const quote = parseCoinstoreKlines(klines());
    expect(quote?.price).toBe(0.00028);
    expect(quote?.change24h).toBeCloseTo(((0.00028 - 0.000309) / 0.000309) * 100, 6);
    // Out of order bars are sorted by time; only the last 24 count.
    const shuffled = klines();
    shuffled.data.item.reverse();
    expect(parseCoinstoreKlines(shuffled)).toEqual(quote);
    for (const bad of [null, {}, { data: { item: [] } }, { data: { item: [{ startTime: 1, open: "0", close: "1" }] } }]) {
      expect(parseCoinstoreKlines(bad)).toBeNull();
    }
  });

  it("prices SAF in USD through Tether, and says where the price comes from", async () => {
    const prices = await getPrices(["safrochain-1", "osmosis-1"]);
    expect(prices["safrochain-1"]?.price).toBeCloseTo(0.00028 * 1.0002, 12);
    expect(prices["safrochain-1"]?.change24h).toBeLessThan(0);
    expect(prices["safrochain-1"]?.source).toEqual({
      name: "Coinstore",
      pair: "SAF/USDT",
      url: "https://www.coinstore.com/spot/SAFUSDT",
    });
    // Aggregator prices stay as they were, without a source.
    expect(prices["osmosis-1"]).toEqual({ price: 0.2, change24h: 2 });
    expect(calls.some((url) => url.includes("/kline/SAFUSDT?period=60min&size=24"))).toBe(true);
  });

  it("converts to the user's currency, and leaves SAF unpriced when USDT cannot be converted", async () => {
    settings.currency = "EUR";
    expect((await getPrices(["safrochain-1"], { force: true }))["safrochain-1"]?.price).toBeCloseTo(0.00028 * 0.92, 12);

    // A failed read keeps the last good prices; start from an empty cache.
    store = {};
    delete routes["https://api.coingecko.com/api/v3/coins/tether"];
    expect((await getPrices(["safrochain-1"], { force: true }))["safrochain-1"]).toBeUndefined();
    // In USD, USDT at par is the only safe assumption without a Tether quote.
    settings.currency = "USD";
    expect((await getPrices(["safrochain-1"], { force: true }))["safrochain-1"]?.price).toBe(0.00028);
  });

  it("leaves SAF unpriced when Coinstore does not answer", async () => {
    store = {};
    delete routes["https://api.coinstore.com/api/v1/market/kline/SAFUSDT"];
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
