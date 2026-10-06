import { bech32 } from "@scure/base";
import type { OsmosisSwapQuote } from "@zunialab/interchain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearInterchainCaches } from "../interchain";
import {
  MAX_POOL_HOPS,
  MAX_POOL_SPLITS,
  POOL_SPLIT_SWAP_TYPE_URL,
  POOL_SWAP_TYPE_URL,
  buildPoolSwapMsg,
  planPoolDelivery,
  planPoolSwap,
  poolMinOut,
  poolRouteText,
  poolRoutesOf,
  quotePoolSwap,
  readDeliveryTransfer,
  readPoolSwapMsg,
  sameRoutes,
  type PoolRoute,
} from "../pool-swap";
import { buildTransferMsgFromPlan, resetChannelChecks } from "../route-plan";
import { isPoolPath, swapPathFor } from "../swap-path";

/**
 * Swaps in Osmosis's own pools (lib/pool-swap.ts): which pairs take that path,
 * the order the router's quote makes, the poolmanager message built from it
 * and read back strictly, and the transfer that sends the output on, planned
 * against a fake Osmosis and Injective behind `fetch`.
 *
 * The numbers are the Osmosis router's real answer for 10 OSMO to USDC.inj on
 * 2026-10-06: split 60/40 across pools 3498 and 3586.
 */

const USDC_INJ = "ibc/794C7D7F3B857713878A3A1927251FA6AC1EEE520424C1F6FAFE9BA26D476138";
const USDC_N = "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4";
const USDC_INJ_ERC20 = "erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a";

const address = (prefix: string, fill: number) => bech32.encode(prefix, bech32.toWords(new Uint8Array(20).fill(fill)));
const OSMO_ME = address("osmo", 7);
const INJ_ME = address("inj", 7);

function quoteOf(splits: { pools: [string, string][]; inAmount: string; outAmount: string }[], outputDenom = USDC_INJ) {
  const outputAmount = splits.reduce((sum, split) => sum + BigInt(split.outAmount), 0n).toString();
  return {
    inputDenom: "uosmo",
    inputAmount: splits.reduce((sum, split) => sum + BigInt(split.inAmount), 0n).toString(),
    outputDenom,
    outputAmount,
    priceImpact: 0.39,
    poolFee: 0.8,
    minReceived: "0",
    slippagePercent: 1,
    route: [],
    source: "router",
    splits: splits.map((split) => ({
      pools: split.pools.map(([poolId, tokenOutDenom]) => ({
        poolId,
        tokenOutDenom,
        spreadFactor: null,
        takerFee: null,
        poolType: null,
      })),
      inAmount: split.inAmount,
      outAmount: split.outAmount,
    })),
    spotPrice: null,
    effectiveFeeFraction: "0.008",
    warnings: [],
    fetchedAt: 0,
  } as OsmosisSwapQuote;
}

const SPLIT = quoteOf([
  { pools: [["3498", USDC_INJ]], inAmount: "6000000", outAmount: "212554" },
  { pools: [["3586", USDC_INJ]], inAmount: "4000000", outAmount: "142080" },
]);
const SPLIT_ROUTES: PoolRoute[] = [
  { hops: [{ poolId: "3498", tokenOutDenom: USDC_INJ }], inAmount: "6000000" },
  { hops: [{ poolId: "3586", tokenOutDenom: USDC_INJ }], inAmount: "4000000" },
];
const TWO_HOPS: PoolRoute[] = [
  {
    hops: [
      { poolId: "3497", tokenOutDenom: USDC_N },
      { poolId: "1464", tokenOutDenom: "uosmo" },
    ],
    inAmount: "1000000",
  },
];

describe("which way a pair swaps", () => {
  const osmosis = { chainId: "osmosis-1" };
  const injective = { chainId: "injective-1" };

  it("swaps funds on Osmosis in its pools, unless the contract can deliver the whole output elsewhere", () => {
    expect(swapPathFor(osmosis, osmosis, "no")).toBe("pool");
    expect(swapPathFor(osmosis, osmosis, "yes")).toBe("pool");
    expect(swapPathFor(osmosis, injective, "yes")).toBe("contract");
    expect(swapPathFor(osmosis, injective, "no")).toBe("pool-deliver");
    expect(swapPathFor(osmosis, injective, "unknown")).toBe("pool-deliver");
  });

  it("sends funds elsewhere through the contract, and moves them to Osmosis first when it has no route", () => {
    expect(swapPathFor(injective, osmosis, "yes")).toBe("contract");
    expect(swapPathFor(injective, osmosis, "unknown")).toBe("contract");
    expect(swapPathFor(injective, osmosis, "no")).toBe("move-first");
    expect(isPoolPath("pool")).toBe(true);
    expect(isPoolPath("pool-deliver")).toBe(true);
    expect(isPoolPath("move-first")).toBe(false);
    expect(isPoolPath(null)).toBe(false);
  });
});

describe("the router's order", () => {
  it("takes every split for exactly the amount sold", () => {
    expect(poolRoutesOf(SPLIT, "10000000")).toEqual(SPLIT_ROUTES);
    const single = quoteOf([{ pools: [["3586", USDC_INJ]], inAmount: "9950000", outAmount: "350000" }]);
    expect(poolRoutesOf(single, "9950000")).toEqual([
      { hops: [{ poolId: "3586", tokenOutDenom: USDC_INJ }], inAmount: "9950000" },
    ]);
  });

  it("refuses an order that would sell another amount, or that the chain would refuse", () => {
    // Splits that do not add up to the amount reviewed.
    expect(poolRoutesOf(SPLIT, "9999999")).toBeNull();
    // A route that ends in another token.
    expect(
      poolRoutesOf(
        quoteOf([{ pools: [["1", USDC_N]], inAmount: "5", outAmount: "1" }]),
        "5",
      ),
    ).toBeNull();
    // Two routes through the same pools.
    expect(
      poolRoutesOf(
        quoteOf([
          { pools: [["3586", USDC_INJ]], inAmount: "5", outAmount: "1" },
          { pools: [["3586", USDC_INJ]], inAmount: "5", outAmount: "1" },
        ]),
        "10",
      ),
    ).toBeNull();
    // A pool id that is not one, a route with no input, a route with no pool.
    expect(poolRoutesOf(quoteOf([{ pools: [["0", USDC_INJ]], inAmount: "5", outAmount: "1" }]), "5")).toBeNull();
    expect(
      poolRoutesOf(
        quoteOf([
          { pools: [["1", USDC_INJ]], inAmount: "5", outAmount: "1" },
          { pools: [["2", USDC_INJ]], inAmount: "0", outAmount: "0" },
        ]),
        "5",
      ),
    ).toBeNull();
    expect(poolRoutesOf(quoteOf([{ pools: [], inAmount: "5", outAmount: "1" }]), "5")).toBeNull();
    // Too long, or split too many ways.
    const long = quoteOf([
      {
        pools: Array.from({ length: MAX_POOL_HOPS + 1 }, (_, i) => [String(i + 1), USDC_INJ] as [string, string]),
        inAmount: "5",
        outAmount: "1",
      },
    ]);
    expect(poolRoutesOf(long, "5")).toBeNull();
    const wide = quoteOf(
      Array.from({ length: MAX_POOL_SPLITS + 1 }, (_, i) => ({
        pools: [[String(i + 1), USDC_INJ]] as [string, string][],
        inAmount: "1",
        outAmount: "1",
      })),
    );
    expect(poolRoutesOf(wide, String(MAX_POOL_SPLITS + 1))).toBeNull();
  });

  it("floors the output at the slippage, rounding down, and never at nothing", () => {
    expect(poolMinOut({ outputAmount: "354634" }, 1)).toBe("351087");
    expect(poolMinOut({ outputAmount: "354634" }, 0.5)).toBe("352860");
    expect(poolMinOut({ outputAmount: "1" }, 1)).toBeNull();
    expect(poolMinOut({ outputAmount: "0" }, 1)).toBeNull();
  });

  it("says the route in words", () => {
    expect(poolRouteText(SPLIT_ROUTES)).toBe("2 routes: pool 3498 (60%) and pool 3586 (40%)");
    expect(poolRouteText(TWO_HOPS)).toBe("pools 3497 → 1464");
    expect(poolRouteText([{ hops: [{ poolId: "3586", tokenOutDenom: USDC_INJ }], inAmount: "1" }])).toBe("pool 3586");
  });
});

describe("the poolmanager message", () => {
  it("is MsgSwapExactAmountIn for one route, with the whole input as token_in", () => {
    const msg = buildPoolSwapMsg({ sender: OSMO_ME, denom: "uosmo", routes: TWO_HOPS, minOut: "28000000" });
    expect(msg).toEqual({
      typeUrl: POOL_SWAP_TYPE_URL,
      value: {
        sender: OSMO_ME,
        routes: [
          { pool_id: "3497", token_out_denom: USDC_N },
          { pool_id: "1464", token_out_denom: "uosmo" },
        ],
        token_in: { denom: "uosmo", amount: "1000000" },
        token_out_min_amount: "28000000",
      },
    });
  });

  it("is MsgSplitRouteSwapExactAmountIn for a split order, each route with its share", () => {
    const msg = buildPoolSwapMsg({ sender: OSMO_ME, denom: "uosmo", routes: SPLIT_ROUTES, minOut: "351087" });
    expect(msg).toEqual({
      typeUrl: POOL_SPLIT_SWAP_TYPE_URL,
      value: {
        sender: OSMO_ME,
        routes: [
          { pools: [{ pool_id: "3498", token_out_denom: USDC_INJ }], token_in_amount: "6000000" },
          { pools: [{ pool_id: "3586", token_out_denom: USDC_INJ }], token_in_amount: "4000000" },
        ],
        token_in_denom: "uosmo",
        token_out_min_amount: "351087",
      },
    });
  });

  it("refuses to build a swap with no floor, a bad denom, or routes that are not an order", () => {
    expect(() => buildPoolSwapMsg({ sender: OSMO_ME, denom: "uosmo", routes: SPLIT_ROUTES, minOut: "0" })).toThrow();
    expect(() => buildPoolSwapMsg({ sender: OSMO_ME, denom: "u", routes: SPLIT_ROUTES, minOut: "1" })).toThrow();
    expect(() => buildPoolSwapMsg({ sender: OSMO_ME, denom: "uosmo", routes: [], minOut: "1" })).toThrow();
  });

  it("reads back exactly what it built", () => {
    const single = buildPoolSwapMsg({ sender: OSMO_ME, denom: "uosmo", routes: TWO_HOPS, minOut: "28000000" });
    expect(readPoolSwapMsg(single)).toEqual({
      split: false,
      sender: OSMO_ME,
      sold: { denom: "uosmo", amount: "1000000" },
      outputDenom: "uosmo",
      minOut: "28000000",
      routes: TWO_HOPS,
    });
    const split = buildPoolSwapMsg({ sender: OSMO_ME, denom: "uosmo", routes: SPLIT_ROUTES, minOut: "351087" });
    const read = readPoolSwapMsg(split);
    expect(read).toMatchObject({ split: true, sold: { denom: "uosmo", amount: "10000000" }, outputDenom: USDC_INJ });
    expect(sameRoutes(read?.routes ?? [], SPLIT_ROUTES)).toBe(true);
    expect(sameRoutes(read?.routes ?? [], TWO_HOPS)).toBe(false);
  });

  it("refuses to read a message with anything it would not show", () => {
    const base = buildPoolSwapMsg({ sender: OSMO_ME, denom: "uosmo", routes: SPLIT_ROUTES, minOut: "351087" });
    const value = base.value as Record<string, unknown>;
    const variants: Record<string, unknown>[] = [
      { ...value, extra: "x" },
      { ...value, token_out_min_amount: "0" },
      { ...value, token_out_min_amount: "007" },
      { ...value, token_out_min_amount: 351087 },
      { ...value, token_in_denom: "" },
      { ...value, routes: [] },
      { ...value, routes: [{ pools: [{ pool_id: "3498", token_out_denom: USDC_INJ, extra: 1 }], token_in_amount: "1" }] },
      { ...value, routes: [{ pools: [{ pool_id: 3498, token_out_denom: USDC_INJ }], token_in_amount: "1" }] },
      {
        ...value,
        routes: [
          { pools: [{ pool_id: "3498", token_out_denom: USDC_INJ }], token_in_amount: "1" },
          { pools: [{ pool_id: "3586", token_out_denom: USDC_N }], token_in_amount: "1" },
        ],
      },
    ];
    for (const variant of variants) {
      expect(readPoolSwapMsg({ typeUrl: POOL_SPLIT_SWAP_TYPE_URL, value: variant as never })).toBeNull();
    }
    expect(readPoolSwapMsg({ typeUrl: "/osmosis.gamm.v1beta1.MsgSwapExactAmountIn", value: value as never })).toBeNull();
    expect(readPoolSwapMsg({ typeUrl: POOL_SWAP_TYPE_URL, value: value as never })).toBeNull();
    expect(readPoolSwapMsg(undefined)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- *
 * A fake Osmosis, Injective and Osmosis router behind fetch
 * -------------------------------------------------------------------------- */

const REST: Record<string, string> = {
  "osmosis-1": "https://lcd-osmosis.keplr.app",
  "injective-1": "https://lcd-injective.keplr.app",
};
const CHANNELS: Record<string, { channelId: string; counterpartyChainId: string; counterpartyChannelId: string; clientId: string }[]> = {
  "osmosis-1": [{ channelId: "channel-122", counterpartyChainId: "injective-1", counterpartyChannelId: "channel-8", clientId: "07-tendermint-1" }],
  "injective-1": [{ channelId: "channel-8", counterpartyChainId: "osmosis-1", counterpartyChannelId: "channel-122", clientId: "07-tendermint-2" }],
};
const TRACES: Record<string, { path: string; base_denom: string }> = {
  [USDC_INJ.slice(4)]: { path: "transfer/channel-122", base_denom: USDC_INJ_ERC20 },
};

function respond(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(body) } as unknown as Response;
}

let router: (url: URL) => Response;

function chainAnswer(chainId: string, url: URL): Response {
  const path = decodeURIComponent(url.pathname);
  const rows = CHANNELS[chainId] ?? [];
  const connectionOf = (clientId: string) => `connection-for-${clientId}`;
  const notFound = respond(404, { code: 5, message: `${path}: not found` });
  let match: RegExpMatchArray | null;
  if ((match = path.match(/^\/ibc\/core\/channel\/v1\/channels\/([^/]+)\/ports\/transfer\/client_state$/))) {
    const r = rows.find((candidate) => candidate.channelId === match![1]);
    return r
      ? respond(200, { identified_client_state: { client_id: r.clientId, client_state: { "@type": "/ibc.lightclients.tendermint.v1.ClientState", chain_id: r.counterpartyChainId } } })
      : notFound;
  }
  if ((match = path.match(/^\/ibc\/core\/channel\/v1\/channels\/([^/]+)\/ports\/transfer$/))) {
    const r = rows.find((candidate) => candidate.channelId === match![1]);
    return r
      ? respond(200, { channel: { state: "STATE_OPEN", ordering: "ORDER_UNORDERED", counterparty: { port_id: "transfer", channel_id: r.counterpartyChannelId }, connection_hops: [connectionOf(r.clientId)], version: "ics20-1" } })
      : notFound;
  }
  if (path === "/ibc/core/channel/v1/channels") {
    return respond(200, {
      channels: rows.map((r) => ({ state: "STATE_OPEN", ordering: "ORDER_UNORDERED", counterparty: { port_id: "transfer", channel_id: r.counterpartyChannelId }, connection_hops: [connectionOf(r.clientId)], version: "ics20-1", port_id: "transfer", channel_id: r.channelId })),
      pagination: { next_key: null, total: String(rows.length) },
    });
  }
  if ((match = path.match(/^\/ibc\/core\/connection\/v1\/connections\/(.+)$/))) {
    const r = rows.find((candidate) => connectionOf(candidate.clientId) === match![1]);
    return r ? respond(200, { connection: { client_id: r.clientId, state: "STATE_OPEN" } }) : notFound;
  }
  if ((match = path.match(/^\/ibc\/core\/client\/v1\/client_states\/(.+)$/))) {
    const r = rows.find((candidate) => candidate.clientId === match![1]);
    return r ? respond(200, { client_state: { "@type": "/ibc.lightclients.tendermint.v1.ClientState", chain_id: r.counterpartyChainId } }) : notFound;
  }
  if ((match = path.match(/^\/ibc\/core\/client\/v1\/client_status\/(.+)$/))) {
    return rows.some((candidate) => candidate.clientId === match![1]) ? respond(200, { status: "Active" }) : notFound;
  }
  if ((match = path.match(/^\/ibc\/apps\/transfer\/v1\/denom_traces\/([0-9A-F]{64})$/)) && chainId === "osmosis-1") {
    const trace = TRACES[match[1]!];
    return trace ? respond(200, { denom_trace: trace }) : notFound;
  }
  return respond(501, { code: 12, message: "Not Implemented" });
}

/** The router's real answer for 10 OSMO → USDC.inj, scaled to the amount asked. */
function splitQuote(url: URL): Response {
  if (url.pathname !== "/router/quote") return respond(501, { message: "Not Implemented" });
  const tokenIn = url.searchParams.get("tokenIn") ?? "";
  const amount = BigInt(tokenIn.match(/^\d+/)?.[0] ?? "0");
  const out = url.searchParams.get("tokenOutDenom") ?? "";
  if (out !== USDC_INJ) return respond(400, { message: "no routes were provided for the pair" });
  const first = (amount * 6n) / 10n;
  const second = amount - first;
  // The router's own outputs for 6 and 4 OSMO, scaled to the amount asked.
  const outFirst = ((first * 212554n) / 6_000_000n).toString();
  const outSecond = ((second * 142080n) / 4_000_000n).toString();
  return respond(200, {
    amount_in: { denom: "uosmo", amount: amount.toString() },
    amount_out: (BigInt(outFirst) + BigInt(outSecond)).toString(),
    route: [
      { pools: [{ id: 3498, type: 2, token_out_denom: USDC_INJ, spread_factor: "0.002", taker_fee: "0.008" }], in_amount: first.toString(), out_amount: outFirst },
      { pools: [{ id: 3586, type: 0, token_out_denom: USDC_INJ, spread_factor: "0.003", taker_fee: "0.008" }], in_amount: second.toString(), out_amount: outSecond },
    ],
    effective_fee: "0.008",
    price_impact: "-0.003872499987184370",
    in_base_out_quote_spot_price: "0.035888372884826882",
  });
}

beforeEach(() => {
  clearInterchainCaches();
  resetChannelChecks();
  router = splitQuote;
  vi.stubGlobal("fetch", async (input: string): Promise<Response> => {
    const url = new URL(String(input));
    if (url.origin === "https://sqs.osmosis.zone") return router(url);
    const chainId = Object.entries(REST).find(([, rest]) => rest === url.origin)?.[0];
    if (!chainId) return respond(503, { message: `unexpected ${url.href}` });
    return chainAnswer(chainId, url);
  });
  const store = new Map<string, unknown>([["zunia.settings", { liveBalances: true }]]);
  vi.stubGlobal("browser", {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: store.get(key) }),
        set: async (patch: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(patch)) store.set(k, v);
        },
        remove: async (key: string) => void store.delete(key),
      },
    },
    permissions: { contains: async () => true },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pricing in the pools", () => {
  it("prices along the router's split and works out the order and the floor", async () => {
    const priced = await quotePoolSwap({
      venueInputDenom: "uosmo",
      venueOutputDenom: USDC_INJ,
      amountBaseUnits: "10000000",
      slippagePercent: 1,
    });
    expect(priced.error).toBeNull();
    expect(priced.quote?.outputAmount).toBe("354634");
    expect(priced.routes).toEqual(SPLIT_ROUTES);
    expect(priced.minOut).toBe("351087");
  });

  it("says when Osmosis has no pool route, and refuses to price a token against itself", async () => {
    const none = await quotePoolSwap({
      venueInputDenom: "uosmo",
      venueOutputDenom: USDC_N,
      amountBaseUnits: "10000000",
      slippagePercent: 1,
    });
    expect(none).toMatchObject({ quote: null, routes: null, minOut: null, code: "no-pool-route" });
    const same = await quotePoolSwap({
      venueInputDenom: USDC_INJ,
      venueOutputDenom: USDC_INJ,
      amountBaseUnits: "1",
      slippagePercent: 1,
    });
    expect(same.code).toBe("same-token");
  });

  it("refuses a split the router could not make add up", async () => {
    router = (url) => {
      const answer = splitQuote(url);
      return {
        ...answer,
        text: async () => {
          const body = JSON.parse(await answer.text()) as { route: { in_amount: string }[] };
          body.route[1]!.in_amount = "1";
          return JSON.stringify(body);
        },
      } as Response;
    };
    // Another amount than the tests above: the router client keeps its answers a while.
    const priced = await quotePoolSwap({
      venueInputDenom: "uosmo",
      venueOutputDenom: USDC_INJ,
      amountBaseUnits: "20000000",
      slippagePercent: 1,
    });
    expect(priced, JSON.stringify(priced)).toMatchObject({ code: "routes-invalid", routes: null });
  });
});

describe("the transfer after the swap", () => {
  it("plans one direct hop home over the canonical channel, delivering exactly the To's denom", async () => {
    const leg = await planPoolDelivery({
      destChainId: "injective-1",
      destDenom: USDC_INJ_ERC20,
      venueOutputDenom: USDC_INJ,
      amountBaseUnits: "351087",
      sender: OSMO_ME,
      recipient: INJ_ME,
      resolveAddresses: async () => ({}),
    });
    expect(leg.error).toBeNull();
    expect(leg.view?.plan.hops).toHaveLength(1);
    expect(leg.view?.plan.hops[0]).toMatchObject({ chainId: "osmosis-1", channelId: "channel-122" });
    expect(leg.view?.plan.outputDenom).toBe(USDC_INJ_ERC20);
    expect(leg.view?.plan.memo).toBe("");

    // The transfer the swap signs after it, read back.
    const msg = buildTransferMsgFromPlan({ view: leg.view!, sender: OSMO_ME, amountBaseUnits: "351087" });
    const read = readDeliveryTransfer(msg);
    expect(read).toMatchObject({
      sourcePort: "transfer",
      sourceChannel: "channel-122",
      token: { denom: USDC_INJ, amount: "351087" },
      sender: OSMO_ME,
      receiver: INJ_ME,
      memo: "",
    });
    expect(BigInt(read?.timeoutTimestamp ?? "0")).toBeGreaterThan(BigInt(Date.now()) * 1_000_000n);
  });

  it("refuses a delivery that would arrive as another variant", async () => {
    const leg = await planPoolDelivery({
      destChainId: "injective-1",
      destDenom: "erc20:0x0000000000000000000000000000000000000001",
      venueOutputDenom: USDC_INJ,
      amountBaseUnits: "1",
      sender: OSMO_ME,
      recipient: INJ_ME,
      resolveAddresses: async () => ({}),
    });
    expect(leg.error).toMatch(/another variant/);
  });

  it("refuses to read a transfer with a field it does not know or a timeout it cannot read", () => {
    const value = {
      source_port: "transfer",
      source_channel: "channel-122",
      token: { denom: USDC_INJ, amount: "1" },
      sender: OSMO_ME,
      receiver: INJ_ME,
      timeout_height: { revision_number: "0", revision_height: "0" },
      timeout_timestamp: "1",
      memo: "",
    };
    const typeUrl = "/ibc.applications.transfer.v1.MsgTransfer";
    expect(readDeliveryTransfer({ typeUrl, value })).not.toBeNull();
    expect(readDeliveryTransfer({ typeUrl, value: { ...value, extra: true } })).toBeNull();
    expect(readDeliveryTransfer({ typeUrl, value: { ...value, timeout_timestamp: 1 } })).toBeNull();
    expect(readDeliveryTransfer({ typeUrl, value: { ...value, timeout_height: { revision_number: "0", x: "1" } } })).toBeNull();
    expect(readDeliveryTransfer({ typeUrl: POOL_SWAP_TYPE_URL, value })).toBeNull();
  });
});

describe("one plan", () => {
  it("prices the swap and plans the transfer for the floor the price gives", async () => {
    const plan = await planPoolSwap({
      venueInputDenom: "uosmo",
      venueOutputDenom: USDC_INJ,
      amountBaseUnits: "10000000",
      slippagePercent: 1,
      delivery: {
        destChainId: "injective-1",
        destDenom: USDC_INJ_ERC20,
        sender: OSMO_ME,
        recipient: INJ_ME,
        resolveAddresses: async () => ({}),
      },
    });
    expect(plan.quote.minOut).toBe("351087");
    expect(plan.delivery?.error).toBeNull();
    expect(plan.delivery?.view?.plan.hops[0]?.channelId).toBe("channel-122");
  });

  it("plans no transfer without a price, and refuses denoms that are not denoms before reading anything", async () => {
    const unpriced = await planPoolSwap({
      venueInputDenom: "uosmo",
      venueOutputDenom: USDC_N,
      amountBaseUnits: "10000000",
      slippagePercent: 1,
      delivery: {
        destChainId: "noble-1",
        destDenom: "uusdc",
        sender: OSMO_ME,
        recipient: address("noble", 7),
        resolveAddresses: async () => ({}),
      },
    });
    expect(unpriced.quote.code).toBe("no-pool-route");
    expect(unpriced.delivery).toBeNull();
    const unnamed = await planPoolSwap({
      venueInputDenom: "",
      venueOutputDenom: USDC_INJ,
      amountBaseUnits: "1",
      slippagePercent: 1,
    });
    expect(unnamed.quote.error).toMatch(/could not name both tokens/);
  });
});
