import { InterchainError, type LcdClient, type LcdRequestOptions } from "@zunialab/interchain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { identityOf } from "../token-identity";
import {
  BOTH_ON_OSMOSIS_REASON,
  SAME_TOKEN_REASON,
  SELF_REASON,
  TESTNET_REASON,
  XCS_ROUTES_CACHE_VERSION,
  XCS_ROUTES_TTL_MS,
  executable,
  executableBetween,
  gateOption,
  gateOptions,
  loadXcsRoutes,
  noRouteReason,
  osmosisDenomFor,
  parseRouterState,
  readRoutingTable,
  resetXcsRoutesMemory,
  type GateSide,
  type XcsRouteTable,
} from "../xcs-routes";
import live from "./fixtures/swap/xcs-route-table.json";

const XCS = live.xcsContract;
const ROUTER = live.swapContract;
const CONFIG_PATH = `/cosmwasm/wasm/v1/contract/${XCS}/raw/Y29uZmln`;
const STATE_PATH = `/cosmwasm/wasm/v1/contract/${ROUTER}/state`;
const MODELS: unknown[] = live.pages.flatMap((page) => page.body.models);

const USDC_AXL = "ibc/D189335C6E4A68B513C10AB227BF1C1D38C746766278BA3EEB4FB14124F1D858";
const USDC_INJ = "ibc/794C7D7F3B857713878A3A1927251FA6AC1EEE520424C1F6FAFE9BA26D476138";
const USDC_N = "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4";
const ATOM = "ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2";
const STATOM = "ibc/C140AFD542AE77BD7DCC83F13FDD8C5E5BB8C4929785E6EC2F4C636F98F17901";
const USDC_INJ_ERC20 = "erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a";
const UNLISTED = "ibc/0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF";

const table: XcsRouteTable = { xcsContract: XCS, swapContract: ROUTER, routes: parseRouterState(MODELS), readAt: 0 };

/** The Osmosis LCD as it answered on 2026-10-05, serving each state page by its key. */
function liveLcd(): LcdClient & { requests: string[] } {
  const requests: string[] = [];
  return {
    chainId: "osmosis-1",
    requests,
    async getJson(path: string, options?: LcdRequestOptions) {
      if (options?.signal?.aborted) throw new InterchainError("aborted", "cancelled");
      const key = options?.query?.["pagination.key"];
      requests.push(key ? `${path}?key=${String(key)}` : path);
      if (path === CONFIG_PATH) return live.config;
      if (path === STATE_PATH) {
        const page = live.pages.find((candidate) => candidate.key === (key ?? null));
        if (page) return page.body;
      }
      throw new InterchainError("lcd-unreachable", `no answer for ${path}`);
    },
  };
}

function failingLcd(code: "lcd-unreachable" | "reads-disabled" = "lcd-unreachable"): LcdClient {
  return {
    chainId: "osmosis-1",
    getJson: async () => {
      throw new InterchainError(code, "osmosis-1: down");
    },
  };
}

/** A `routing_table` key as cw-storage-plus writes it, in the LCD's hex. */
function routeKey(input: string, output: string, namespace = "routing_table"): string {
  const bytes = (text: string) => [...Buffer.from(text, "utf8")];
  const length = (text: string) => [Buffer.byteLength(text) >> 8, Buffer.byteLength(text) & 0xff];
  return Buffer.from([...length(namespace), ...bytes(namespace), ...length(input), ...bytes(input), ...bytes(output)])
    .toString("hex")
    .toUpperCase();
}

function routeValue(hops: readonly { pool_id: string | number; token_out_denom: string }[]): string {
  return Buffer.from(JSON.stringify(hops)).toString("base64");
}

function side(chainId: string, denom: string, testnet = false): GateSide {
  return { key: `${chainId}:${denom}`, chainId, denom, identity: identityOf(chainId, denom), testnet };
}

describe("parseRouterState", () => {
  it("reads the 39 routing_table entries out of the router's 41 models", () => {
    expect(MODELS).toHaveLength(41);
    const routes = parseRouterState(MODELS);
    expect(routes).toHaveLength(39);
    expect(routes).toContainEqual({ input: "uosmo", output: USDC_AXL, poolIds: ["678"] });
    expect(routes).toContainEqual({ input: ATOM, output: STATOM, poolIds: ["803"] });
    const denoms = new Set(routes.flatMap((route) => [route.input, route.output]));
    expect(denoms.size).toBe(20);
    // The only USDC the contract trades is Axelar's, against OSMO.
    expect(routes.filter((route) => route.input === USDC_AXL || route.output === USDC_AXL)).toHaveLength(2);
    for (const denom of [USDC_INJ, USDC_N]) expect(denoms.has(denom)).toBe(false);
  });

  it("skips items, other maps, bad keys and values that are not a route to the output", () => {
    const item = Buffer.from("contract_info").toString("hex");
    const models = [
      { key: item, value: Buffer.from('{"contract":"crates.io:swaprouter"}').toString("base64") },
      { key: routeKey("uosmo", ATOM, "routing_tablx"), value: routeValue([{ pool_id: "1", token_out_denom: ATOM }]) },
      { key: `${routeKey("uosmo", ATOM)}0`, value: routeValue([{ pool_id: "1", token_out_denom: ATOM }]) },
      { key: routeKey("uosmo", ATOM), value: routeValue([{ pool_id: "1", token_out_denom: USDC_AXL }]) },
      { key: routeKey("uosmo", USDC_AXL), value: "not base64 json" },
      { key: routeKey("uosmo", "ibc/x y"), value: routeValue([{ pool_id: "1", token_out_denom: "ibc/x y" }]) },
      { key: routeKey("uosmo", STATOM), value: routeValue([{ pool_id: "0", token_out_denom: STATOM }]) },
      { key: routeKey("uosmo", "uion"), value: routeValue([{ pool_id: 2, token_out_denom: "uion" }]) },
      { key: routeKey("uosmo", "uion"), value: routeValue([{ pool_id: 3, token_out_denom: "uion" }]) },
      null,
      "routing_table",
    ];
    expect(parseRouterState(models)).toEqual([{ input: "uosmo", output: "uion", poolIds: ["2"] }]);
  });
});

describe("readRoutingTable", () => {
  it("reads the contract's config, then every page of its router's state", async () => {
    const lcd = liveLcd();
    const read = await readRoutingTable(lcd, XCS, { now: 1_000 });
    expect(read.xcsContract).toBe(XCS);
    expect(read.swapContract).toBe(ROUTER);
    expect(read.readAt).toBe(1_000);
    expect(read.routes).toEqual(table.routes);
    expect(lcd.requests).toEqual([
      CONFIG_PATH,
      STATE_PATH,
      `${STATE_PATH}?key=${live.pages[1]?.key}`,
      `${STATE_PATH}?key=${live.pages[2]?.key}`,
    ]);
  });

  it("refuses an address that is not one, a config without a router and a state without routes", async () => {
    await expect(readRoutingTable(liveLcd(), "not-a-contract")).rejects.toMatchObject({ code: "invalid-request" });
    const noRouter: LcdClient = {
      chainId: "osmosis-1",
      getJson: async () => ({ data: Buffer.from('{"governor":"osmo1x"}').toString("base64") }),
    };
    await expect(readRoutingTable(noRouter, XCS)).rejects.toMatchObject({ code: "malformed-response" });
    const itemsOnly: LcdClient = {
      chainId: "osmosis-1",
      getJson: async (path: string) =>
        path === CONFIG_PATH
          ? live.config
          : { models: MODELS.filter((model) => !String((model as { key: string }).key).startsWith("000D")), pagination: {} },
    };
    await expect(readRoutingTable(itemsOnly, XCS)).rejects.toMatchObject({ code: "malformed-response" });
  });

  it("gives up on a state that never ends instead of trusting part of it", async () => {
    let pages = 0;
    const endless: LcdClient = {
      chainId: "osmosis-1",
      getJson: async (path: string) => {
        if (path === CONFIG_PATH) return live.config;
        pages += 1;
        return { models: live.pages[0]?.body.models ?? [], pagination: { next_key: `page-${pages}` } };
      },
    };
    await expect(readRoutingTable(endless, XCS)).rejects.toMatchObject({ code: "malformed-response" });
    expect(pages).toBe(200);
  });

  it("stops at once when a gateway ignores the page key and repeats the first page", async () => {
    // Seen behind proxies that drop the query string: every answer is page
    // one with the same next key. Before, that cost 200 identical requests.
    const requested: (string | undefined)[] = [];
    const deaf: LcdClient = {
      chainId: "osmosis-1",
      getJson: async (path: string, options?: LcdRequestOptions) => {
        if (path === CONFIG_PATH) return live.config;
        requested.push(options?.query?.["pagination.key"] as string | undefined);
        return live.pages[0]?.body;
      },
    };
    await expect(readRoutingTable(deaf, XCS)).rejects.toMatchObject({ code: "malformed-response" });
    expect(requested).toEqual([undefined, live.pages[1]?.key]);
    // Such a router reads as unknown, which gates no route.
    vi.stubGlobal("browser", { storage: {} });
    try {
      resetXcsRoutesMemory();
      expect(await loadXcsRoutes(XCS, { lcd: deaf })).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("executable", () => {
  it("answers from the table: OSMO to USDC.axl yes, OSMO to USDC.inj no", () => {
    expect(executable(table, "uosmo", USDC_AXL)).toBe("yes");
    expect(executable(table, USDC_AXL, "uosmo")).toBe("yes");
    expect(executable(table, "uosmo", USDC_INJ)).toBe("no");
    expect(executable(table, ATOM, USDC_AXL)).toBe("no");
    // An ibc hash names the same denom in either case.
    expect(executable(table, "uosmo", `ibc/${USDC_AXL.slice(4).toLowerCase()}`)).toBe("yes");
  });

  it("answers unknown without a table or without a name for a side", () => {
    expect(executable(null, "uosmo", USDC_AXL)).toBe("unknown");
    expect(executable(undefined, "uosmo", USDC_AXL)).toBe("unknown");
    expect(executable(table, null, USDC_AXL)).toBe("unknown");
    expect(executable(table, "uosmo", "")).toBe("unknown");
  });

  it("from identities: a coin Osmosis does not list provably has no route; an unnamed one is unknown", () => {
    const osmo = side("osmosis-1", "uosmo");
    expect(executableBetween(table, side("cosmoshub-4", "uatom"), side("axelar-dojo-1", "uusdc"))).toBe("no");
    expect(executableBetween(table, osmo, side("axelar-dojo-1", "uusdc"))).toBe("yes");
    expect(executableBetween(table, osmo, side("safrochain-1", "usaf"))).toBe("no");
    expect(executableBetween(table, side("safrochain-1", "usaf"), osmo)).toBe("no");
    expect(executableBetween(table, osmo, side("injective-1", UNLISTED))).toBe("unknown");
    // A held Osmosis denom is its own name, identified or not.
    expect(executableBetween(table, osmo, side("osmosis-1", UNLISTED))).toBe("no");
    // When the table trades a denom nothing names, absence proves nothing.
    const unnamed: XcsRouteTable = {
      ...table,
      routes: [...table.routes, { input: "uosmo", output: UNLISTED, poolIds: ["1"] }],
    };
    expect(executableBetween(unnamed, osmo, side("safrochain-1", "usaf"))).toBe("unknown");
    expect(executableBetween(null, osmo, side("axelar-dojo-1", "uusdc"))).toBe("unknown");
  });

  it("names a side on Osmosis by its held denom there, else by its canonical voucher", () => {
    expect(osmosisDenomFor(side("osmosis-1", USDC_N))).toBe(USDC_N);
    expect(osmosisDenomFor(side("injective-1", USDC_INJ_ERC20))).toBe(USDC_INJ);
    expect(osmosisDenomFor(side("safrochain-1", "usaf"))).toBeNull();
  });
});

describe("gateOption", () => {
  const osmo = side("osmosis-1", "uosmo");

  it("with From OSMO on Osmosis: no route to USDC.inj on either chain, USDC.axl on Axelar but not on Osmosis", () => {
    const toInjective = gateOption(osmo, side("injective-1", USDC_INJ_ERC20), table);
    expect(toInjective).toEqual({
      executable: "no",
      disabledReason: "Zunia's Osmosis swap contract has no route from OSMO to USDC.inj yet.",
    });
    // No route outranks the both-on-Osmosis rule: delivering elsewhere would not help.
    expect(gateOption(osmo, side("osmosis-1", USDC_INJ), table)).toEqual(toInjective);
    expect(gateOption(osmo, side("noble-1", "uusdc"), table).disabledReason).toBe(noRouteReason("OSMO", "USDC.n"));
    expect(gateOption(osmo, side("axelar-dojo-1", "uusdc"), table)).toEqual({ executable: "yes", disabledReason: null });
    expect(gateOption(osmo, side("osmosis-1", USDC_AXL), table)).toEqual({
      executable: "yes",
      disabledReason: BOTH_ON_OSMOSIS_REASON,
    });
  });

  it("refuses the From itself and the same asset anywhere else", () => {
    expect(gateOption(osmo, osmo, table).disabledReason).toBe(SELF_REASON);
    const atom = side("cosmoshub-4", "uatom");
    expect(gateOption(atom, side("osmosis-1", ATOM), table).disabledReason).toBe(SAME_TOKEN_REASON);
    expect(gateOption(side("osmosis-1", USDC_N), side("noble-1", "uusdc"), table).disabledReason).toBe(
      SAME_TOKEN_REASON,
    );
  });

  it("refuses testnet sides: the only venue is Osmosis mainnet", () => {
    const testnet = side("safro-testnet-1", "usaf", true);
    expect(gateOption(testnet, side("osmo-test-5", "uosmo", true), table).disabledReason).toBe(TESTNET_REASON);
    expect(gateOption(testnet, side("osmo-test-5", "uosmo", true), null).disabledReason).toBe(TESTNET_REASON);
  });

  it("gates no route when the table is unreadable, and nothing at all without a From", () => {
    expect(gateOption(osmo, side("injective-1", USDC_INJ_ERC20), null)).toEqual({
      executable: "unknown",
      disabledReason: null,
    });
    // Both on Osmosis is the screen's own rule, not the table's.
    expect(gateOption(osmo, side("osmosis-1", USDC_INJ), null).disabledReason).toBe(BOTH_ON_OSMOSIS_REASON);
    expect(gateOption(null, side("injective-1", USDC_INJ_ERC20), table)).toEqual({
      executable: "unknown",
      disabledReason: null,
    });
  });

  it("gateOptions keeps every row, in order, with its verdict", () => {
    const rows = [side("axelar-dojo-1", "uusdc"), side("injective-1", USDC_INJ_ERC20)];
    const gated = gateOptions(osmo, rows, table);
    expect(gated.map((row) => [row.key, row.executable])).toEqual([
      ["axelar-dojo-1:uusdc", "yes"],
      [`injective-1:${USDC_INJ_ERC20}`, "no"],
    ]);
    expect(gated[1]?.identity).toBe(rows[1]?.identity);
  });
});

describe("loadXcsRoutes", () => {
  let stored: Map<string, unknown>;

  beforeEach(() => {
    resetXcsRoutesMemory();
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

  it("reads once, then serves the session copy for an hour", async () => {
    const lcd = liveLcd();
    const first = await loadXcsRoutes(XCS, { lcd, now: 10_000 });
    expect(first?.routes).toHaveLength(39);
    expect(lcd.requests).toHaveLength(4);
    const record = stored.get("zunia.xcsRoutes") as { version: number; xcsContract: string; routes: string[][] };
    expect(record.version).toBe(XCS_ROUTES_CACHE_VERSION);
    expect(record.xcsContract).toBe(XCS);
    expect(record.routes).toContainEqual(["uosmo", USDC_AXL, "678"]);

    // Another popup: memory is empty, the session copy answers.
    resetXcsRoutesMemory();
    const again = await loadXcsRoutes(XCS, { lcd: failingLcd(), now: 10_000 + XCS_ROUTES_TTL_MS });
    expect(again?.routes).toEqual(first?.routes);
    expect(executable(again, "uosmo", USDC_AXL)).toBe("yes");

    resetXcsRoutesMemory();
    expect(await loadXcsRoutes(XCS, { lcd: failingLcd(), now: 10_001 + XCS_ROUTES_TTL_MS })).toBeNull();
  });

  it("keeps a copy to its own contract and version, and refuses a damaged one", async () => {
    await loadXcsRoutes(XCS, { lcd: liveLcd(), now: 10_000 });
    resetXcsRoutesMemory();
    const other = "osmo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
    expect(await loadXcsRoutes(other, { lcd: failingLcd(), now: 10_000 })).toBeNull();

    const record = stored.get("zunia.xcsRoutes") as Record<string, unknown>;
    stored.set("zunia.xcsRoutes", { ...record, version: XCS_ROUTES_CACHE_VERSION + 1 });
    resetXcsRoutesMemory();
    expect(await loadXcsRoutes(XCS, { lcd: failingLcd(), now: 10_000 })).toBeNull();

    stored.set("zunia.xcsRoutes", { ...record, routes: [["uosmo", "bad denom", "1"]] });
    resetXcsRoutesMemory();
    expect(await loadXcsRoutes(XCS, { lcd: failingLcd(), now: 10_000 })).toBeNull();
  });

  it("answers null when the table cannot be read, which gates no route", async () => {
    expect(await loadXcsRoutes(XCS, { lcd: failingLcd(), now: 1 })).toBeNull();
    expect(await loadXcsRoutes(XCS, { lcd: failingLcd("reads-disabled"), now: 1 })).toBeNull();
    expect(stored.size).toBe(0);
    const unreadable = await loadXcsRoutes(XCS, { lcd: failingLcd(), now: 1 });
    const gated = gateOptions(side("osmosis-1", "uosmo"), [side("injective-1", USDC_INJ_ERC20)], unreadable);
    expect(gated[0]).toMatchObject({ executable: "unknown", disabledReason: null });
  });

  it("rejects only when the caller cancels", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(loadXcsRoutes(XCS, { lcd: liveLcd(), signal: controller.signal })).rejects.toMatchObject({
      code: "aborted",
    });
  });

  it("works without session storage, from memory", async () => {
    vi.stubGlobal("browser", { storage: {} });
    expect((await loadXcsRoutes(XCS, { lcd: liveLcd(), now: 5 }))?.routes).toHaveLength(39);
    expect((await loadXcsRoutes(XCS, { lcd: failingLcd(), now: 6 }))?.routes).toHaveLength(39);
  });
});
