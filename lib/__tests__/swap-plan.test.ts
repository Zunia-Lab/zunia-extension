import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ibcDenomHash } from "@zunialab/interchain";

import { clearInterchainCaches } from "../interchain";
import {
  buildTransferMsgFromPlan,
  planSwap,
  planTransfer,
  requoteSwap,
  resetChannelChecks,
  type PlanInput,
  type SwapPlanInput,
} from "../route-plan";

/**
 * Planning end to end, against a fake IBC world behind `fetch`.
 *
 * Everything between the screen and the wire is real: the catalog, the
 * engine's planner, denom resolver and channel service, the canonical channel
 * seeds, and the channel checks this module adds. Only the chains are fake,
 * and they answer the way the live ones did on 2026-10-05: Osmosis channel-109
 * and Injective channel-5 are open with Expired light clients, channel-122 and
 * channel-8 are the live pair, and the crosschain-swaps router has a route for
 * ATOM and OSMO but none for USDC.inj.
 */

const XCS = "osmo1uwk8xc6q0s6t5qcpr6rht3sczu6du83xq8pwxjua0hfj5hzcnh3sqxwvxs";
const ROUTER = "osmo1fy547nr4ewfc38z73ghr6x62p7eguuupm66xwk8v8rjnjyeyxdqs6gdqx7";
const SQS = "https://sqs.osmosis.zone";

/** The catalog's REST endpoint for each chain the fake world serves. */
const REST: Record<string, string> = {
  "cosmoshub-4": "https://lcd-cosmoshub.keplr.app",
  "osmosis-1": "https://lcd-osmosis.keplr.app",
  "injective-1": "https://lcd-injective.keplr.app",
  "noble-1": "https://lcd-noble.keplr.app",
  "safrochain-1": "https://api.safrochain.network",
  "archway-1": "https://api.mainnet.archway.io",
};

const USDC_INJ = "erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a";
const OSMO_ATOM = "ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2";
const OSMO_USDC_INJ = "ibc/794C7D7F3B857713878A3A1927251FA6AC1EEE520424C1F6FAFE9BA26D476138";
const OSMO_USDC_N = "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4";
/** INJ that reached Osmosis over channel-118, not the canonical channel-122. */
const OSMO_INJ_118 = "ibc/D7340FD373EE539F8267FFF939F3FAD675A899944961688CC482EB02B1770B8B";
/** Injective USDC that reached Osmosis over channel-109, whose client expired. */
const OSMO_USDC_INJ_109 = "ibc/4AF599D45AFADFCDAE050345996F09F0E22378C27C9069CD099F9163EAD34D07";

interface FakeChannel {
  readonly channelId: string;
  readonly counterpartyChainId: string;
  readonly counterpartyChannelId: string;
  readonly clientId: string;
  state: string;
  clientStatus: string;
}

interface FakeWorld {
  readonly channels: Record<string, FakeChannel[]>;
  /** Chains whose node does not serve `client_status` (a gateway's 501). */
  readonly noStatusRoute: Set<string>;
  /**
   * `chainId:channel-N` rows the chain's channel list does not reach: Osmosis
   * lists about a thousand interchain-account channels first, so a walk of
   * its list stops before any transfer channel.
   */
  readonly unlisted: Set<string>;
  /** Answers that replace the fake chain's own for one path, or `null` to pass. */
  override: ((chainId: string, path: string) => Response | null) | null;
  readonly requested: URL[];
}

function channel(
  channelId: string,
  counterpartyChainId: string,
  counterpartyChannelId: string,
  clientId: string,
  clientStatus = "Active",
): FakeChannel {
  return {
    channelId,
    counterpartyChainId,
    counterpartyChannelId,
    clientId,
    state: "STATE_OPEN",
    clientStatus,
  };
}

/** Live channel numbers and client ids; statuses as read on 2026-10-05 unless a test edits them. */
function liveWorld(): FakeWorld {
  return {
    channels: {
      "osmosis-1": [
        channel("channel-0", "cosmoshub-4", "channel-141", "07-tendermint-1"),
        channel("channel-109", "injective-1", "channel-5", "07-tendermint-1617", "Expired"),
        // Expired on chain too; Active here so a test can pin a channel that
        // fails only on the missing status route.
        channel("channel-118", "injective-1", "channel-6", "07-tendermint-1673"),
        channel("channel-122", "injective-1", "channel-8", "07-tendermint-1703"),
        channel("channel-750", "noble-1", "channel-1", "07-tendermint-2704"),
        channel("channel-110497", "safrochain-1", "channel-1", "07-tendermint-3719"),
      ],
      "cosmoshub-4": [
        channel("channel-141", "osmosis-1", "channel-0", "07-tendermint-259"),
        channel("channel-1700", "safrochain-1", "channel-3", "07-tendermint-1900"),
      ],
      "injective-1": [
        channel("channel-5", "osmosis-1", "channel-109", "07-tendermint-11", "Expired"),
        channel("channel-6", "osmosis-1", "channel-118", "07-tendermint-12"),
        channel("channel-8", "osmosis-1", "channel-122", "07-tendermint-19"),
      ],
      "noble-1": [channel("channel-1", "osmosis-1", "channel-750", "07-tendermint-0")],
      "safrochain-1": [
        channel("channel-1", "osmosis-1", "channel-110497", "07-tendermint-1"),
        channel("channel-3", "cosmoshub-4", "channel-1700", "07-tendermint-3"),
      ],
    },
    noStatusRoute: new Set(),
    unlisted: new Set(),
    override: null,
    requested: [],
  };
}

/** Denom traces Osmosis answers, keyed by hash. */
const OSMOSIS_TRACES: Record<string, { path: string; base_denom: string }> = {
  [OSMO_ATOM.slice(4)]: { path: "transfer/channel-0", base_denom: "uatom" },
  [OSMO_USDC_INJ.slice(4)]: { path: "transfer/channel-122", base_denom: USDC_INJ },
  [OSMO_USDC_N.slice(4)]: { path: "transfer/channel-750", base_denom: "uusdc" },
  [OSMO_INJ_118.slice(4)]: { path: "transfer/channel-118", base_denom: "inj" },
  [OSMO_USDC_INJ_109.slice(4)]: { path: "transfer/channel-109", base_denom: USDC_INJ },
};

/** Directional pairs the swaprouter table holds. Every other pair is "not found". */
const ROUTES = new Set([`${OSMO_ATOM}>uosmo`, `uosmo>${OSMO_ATOM}`]);

function respond(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function smartQuery(pathname: string): Record<string, { input_denom: string; output_denom: string }> {
  const encoded = decodeURIComponent(pathname.split("/smart/")[1] ?? "");
  const standard = encoded.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(standard, "base64").toString("utf8")) as Record<
    string,
    { input_denom: string; output_denom: string }
  >;
}

/** One chain's LCD, as much of it as planning reads. */
function chainAnswer(world: FakeWorld, chainId: string, url: URL): Response {
  const path = decodeURIComponent(url.pathname);
  const rows = world.channels[chainId] ?? [];
  const connectionOf = (row: FakeChannel) => `connection-for-${row.clientId}`;
  const notFound = respond(404, { code: 5, message: `${path}: not found`, details: [] });
  let match: RegExpMatchArray | null;
  const overridden = world.override?.(chainId, path);
  if (overridden) return overridden;

  if ((match = path.match(/^\/ibc\/core\/channel\/v1\/channels\/([^/]+)\/ports\/transfer\/client_state$/))) {
    const row = rows.find((r) => r.channelId === match![1]);
    if (!row) return notFound;
    return respond(200, {
      identified_client_state: {
        client_id: row.clientId,
        client_state: {
          "@type": "/ibc.lightclients.tendermint.v1.ClientState",
          chain_id: row.counterpartyChainId,
        },
      },
    });
  }
  if ((match = path.match(/^\/ibc\/core\/channel\/v1\/channels\/([^/]+)\/ports\/transfer$/))) {
    const row = rows.find((r) => r.channelId === match![1]);
    if (!row) return notFound;
    return respond(200, {
      channel: {
        state: row.state,
        ordering: "ORDER_UNORDERED",
        counterparty: { port_id: "transfer", channel_id: row.counterpartyChannelId },
        connection_hops: [connectionOf(row)],
        version: "ics20-1",
      },
    });
  }
  if (path === "/ibc/core/channel/v1/channels") {
    const listed = rows.filter((row) => !world.unlisted.has(`${chainId}:${row.channelId}`));
    return respond(200, {
      channels: listed.map((row) => ({
        state: row.state,
        ordering: "ORDER_UNORDERED",
        counterparty: { port_id: "transfer", channel_id: row.counterpartyChannelId },
        connection_hops: [connectionOf(row)],
        version: "ics20-1",
        port_id: "transfer",
        channel_id: row.channelId,
      })),
      pagination: { next_key: null, total: String(rows.length) },
    });
  }
  if ((match = path.match(/^\/ibc\/core\/connection\/v1\/connections\/(.+)$/))) {
    const row = rows.find((r) => connectionOf(r) === match![1]);
    if (!row) return notFound;
    return respond(200, { connection: { client_id: row.clientId, state: "STATE_OPEN" } });
  }
  if ((match = path.match(/^\/ibc\/core\/client\/v1\/client_states\/(.+)$/))) {
    const row = rows.find((r) => r.clientId === match![1]);
    if (!row) return notFound;
    return respond(200, {
      client_state: {
        "@type": "/ibc.lightclients.tendermint.v1.ClientState",
        chain_id: row.counterpartyChainId,
      },
    });
  }
  if ((match = path.match(/^\/ibc\/core\/client\/v1\/client_status\/(.+)$/))) {
    if (world.noStatusRoute.has(chainId)) {
      return respond(501, { code: 12, message: "Not Implemented", details: [] });
    }
    const row = rows.find((r) => r.clientId === match![1]);
    if (!row) return notFound;
    return respond(200, { status: row.clientStatus });
  }
  if (chainId === "osmosis-1") {
    if ((match = path.match(/^\/ibc\/apps\/transfer\/v1\/denom_traces\/([0-9A-F]{64})$/))) {
      const trace = OSMOSIS_TRACES[match[1]!];
      return trace ? respond(200, { denom_trace: trace }) : notFound;
    }
    if (path === "/ibc/apps/packetforward/v1/params") {
      return respond(200, { params: { fee_percentage: "0.000000000000000000" } });
    }
    if (path === "/ibc/apps/ibchooks/v1/params") {
      return respond(200, { params: { allowed_async_ack_contracts: [] } });
    }
    if (path.startsWith(`/cosmwasm/wasm/v1/contract/${XCS}/raw/`)) {
      const config = JSON.stringify({ governor: "osmo1governor", swap_contract: ROUTER });
      return respond(200, { data: Buffer.from(config, "utf8").toString("base64") });
    }
    if (path.startsWith(`/cosmwasm/wasm/v1/contract/${ROUTER}/smart/`)) {
      const pair = smartQuery(url.pathname).get_route;
      if (pair && ROUTES.has(`${pair.input_denom}>${pair.output_denom}`)) {
        return respond(200, {
          data: { pool_route: [{ pool_id: "1", token_out_denom: pair.output_denom }] },
        });
      }
      // How wasmd answers a pair the swaprouter table does not hold.
      return respond(500, {
        code: 2,
        message:
          "Generic error: Querier contract error: Vec<SwapAmountInRoute> not found: query wasm contract failed",
        details: [],
      });
    }
  }
  // What a gateway says for a route it does not serve.
  return respond(501, { code: 12, message: "Not Implemented", details: [] });
}

function sqsAnswer(url: URL): Response {
  if (url.pathname !== "/router/custom-direct-quote") {
    return respond(501, { code: 12, message: "Not Implemented" });
  }
  const tokenIn = url.searchParams.get("tokenIn") ?? "";
  const amount = tokenIn.match(/^\d+/)?.[0] ?? "0";
  const out = String(BigInt(amount) * 4n);
  return respond(200, {
    amount_in: { denom: tokenIn.slice(amount.length), amount },
    amount_out: out,
    route: [
      {
        pools: [
          {
            id: 1,
            type: 0,
            token_out_denom: url.searchParams.get("tokenOutDenom"),
            spread_factor: "0.002",
            taker_fee: "0.001",
          },
        ],
        in_amount: amount,
        out_amount: out,
      },
    ],
    effective_fee: "0.003",
    price_impact: "-0.0001",
    in_base_out_quote_spot_price: "4.0",
  });
}

let world: FakeWorld;
let store: Map<string, unknown>;

function install(): void {
  world = liveWorld();
  vi.stubGlobal("fetch", async (input: string): Promise<Response> => {
    const url = new URL(String(input));
    world.requested.push(url);
    if (url.origin === SQS) return sqsAnswer(url);
    const chainId = Object.entries(REST).find(([, rest]) => rest === url.origin)?.[0];
    if (!chainId) throw new Error(`unexpected request to ${url.href}`);
    return chainAnswer(world, chainId, url);
  });

  store = new Map<string, unknown>([["zunia.settings", { liveBalances: true }]]);
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
}

/** Requests whose path matches, so a test can count reads. */
function requests(pattern: RegExp): URL[] {
  return world.requested.filter((url) => pattern.test(url.pathname));
}

const VENUE = { chainId: "osmosis-1", contractAddress: XCS, label: "Osmosis" } as const;
const HUB_ADDRESS = "cosmos1sender0000000000000000000000000000000";
const OSMO_ADDRESS = "osmo1sender00000000000000000000000000000000";
const INJ_ADDRESS = "inj1sender000000000000000000000000000000000";
const NOBLE_ADDRESS = "noble1sender0000000000000000000000000000000";
const SAFRO_ADDRESS = "addr_safro1sender00000000000000000000000000";
const ARCHWAY_ADDRESS = "archway1sender000000000000000000000000000000";
const RECOVERY = "osmo1recovery000000000000000000000000000000";

function swap(overrides: Partial<SwapPlanInput>): SwapPlanInput {
  return {
    sourceChainId: "cosmoshub-4",
    destChainId: "osmosis-1",
    inputDenom: "uatom",
    destDenom: "uosmo",
    amountBaseUnits: "1000000",
    sender: HUB_ADDRESS,
    recipient: OSMO_ADDRESS,
    recoveryAddress: RECOVERY,
    slippagePercent: 1,
    venue: VENUE,
    resolveAddresses: async () => ({}),
    ...overrides,
  };
}

function transfer(overrides: Partial<PlanInput>): PlanInput {
  return {
    sourceChainId: "injective-1",
    destChainId: "osmosis-1",
    inputDenom: USDC_INJ,
    amountBaseUnits: "1000000",
    sender: INJ_ADDRESS,
    recipient: OSMO_ADDRESS,
    resolveAddresses: async () => ({}),
    ...overrides,
  };
}

beforeEach(() => {
  install();
  clearInterchainCaches();
  resetChannelChecks();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  clearInterchainCaches();
  resetChannelChecks();
});

/* -------------------------------------------------------------------------- *
 * What 0.1.2 signed, byte for byte
 * -------------------------------------------------------------------------- */

/**
 * Captured from the planner as it stood before the channel checks, on the same
 * fake world. The checks may change which channel is chosen; they must never
 * change what is written for a given route.
 */
const ATOM_TO_OSMO_MEMO =
  '{"wasm":{"contract":"osmo1uwk8xc6q0s6t5qcpr6rht3sczu6du83xq8pwxjua0hfj5hzcnh3sqxwvxs",' +
  '"msg":{"osmosis_swap":{"output_denom":"uosmo",' +
  '"slippage":{"twap":{"slippage_percentage":"1","window_seconds":10}},' +
  '"receiver":"osmo1sender00000000000000000000000000000000",' +
  '"on_failed_delivery":{"local_recovery_addr":"osmo1recovery000000000000000000000000000000"},' +
  '"next_memo":null}}}}';

const ATOM_TO_USDC_INJ_MEMO =
  '{"wasm":{"contract":"osmo1uwk8xc6q0s6t5qcpr6rht3sczu6du83xq8pwxjua0hfj5hzcnh3sqxwvxs",' +
  '"msg":{"osmosis_swap":{"output_denom":"ibc/794C7D7F3B857713878A3A1927251FA6AC1EEE520424C1F6FAFE9BA26D476138",' +
  '"slippage":{"twap":{"slippage_percentage":"1","window_seconds":10}},' +
  '"receiver":"osmo1sender00000000000000000000000000000000",' +
  '"on_failed_delivery":{"local_recovery_addr":"osmo1recovery000000000000000000000000000000"},' +
  '"next_memo":null}}}}';

const ATOM_TO_OSMO_MSG =
  '{"typeUrl":"/ibc.applications.transfer.v1.MsgTransfer","value":{"source_port":"transfer",' +
  '"source_channel":"channel-141","token":{"denom":"uatom","amount":"1000000"},' +
  '"sender":"cosmos1sender0000000000000000000000000000000",' +
  '"receiver":"osmo1uwk8xc6q0s6t5qcpr6rht3sczu6du83xq8pwxjua0hfj5hzcnh3sqxwvxs",' +
  '"timeout_height":{"revision_number":"0","revision_height":"0"},' +
  `"timeout_timestamp":"1791202200000000000","memo":${JSON.stringify(ATOM_TO_OSMO_MEMO)}}}`;

const OSMO_TO_ATOM_MSG =
  '{"typeUrl":"/cosmwasm.wasm.v1.MsgExecuteContract","value":{' +
  '"sender":"osmo1sender00000000000000000000000000000000",' +
  '"contract":"osmo1uwk8xc6q0s6t5qcpr6rht3sczu6du83xq8pwxjua0hfj5hzcnh3sqxwvxs",' +
  '"msg":"' +
  "eyJvc21vc2lzX3N3YXAiOnsib3V0cHV0X2Rlbm9tIjoiaWJjLzI3Mzk0RkIwOTJEMkVDQ0Q1NjEyM0M3NEYzNkU0QzFGOTI2" +
  "MDAxQ0VBREE5Q0E5N0VBNjIyQjI1RjQxRTVFQjIiLCJzbGlwcGFnZSI6eyJ0d2FwIjp7InNsaXBwYWdlX3BlcmNlbnRhZ2Ui" +
  "OiIxIiwid2luZG93X3NlY29uZHMiOjEwfX0sInJlY2VpdmVyIjoiY29zbW9zMXNlbmRlcjAwMDAwMDAwMDAwMDAwMDAwMDAw" +
  "MDAwMDAwMDAwMDAiLCJvbl9mYWlsZWRfZGVsaXZlcnkiOnsibG9jYWxfcmVjb3ZlcnlfYWRkciI6Im9zbW8xcmVjb3Zlcnkw" +
  "MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAifSwibmV4dF9tZW1vIjpudWxsfX0=" +
  '","funds":[{"denom":"uosmo","amount":"63000000"}]}}';

const HUB_TO_OSMO_TRANSFER_MSG =
  '{"typeUrl":"/ibc.applications.transfer.v1.MsgTransfer","value":{"source_port":"transfer",' +
  '"source_channel":"channel-141","token":{"denom":"uatom","amount":"1000000"},' +
  '"sender":"cosmos1sender0000000000000000000000000000000",' +
  '"receiver":"osmo1sender00000000000000000000000000000000",' +
  '"timeout_height":{"revision_number":"0","revision_height":"0"},' +
  '"timeout_timestamp":"1791202200000000000","memo":""}}';

const NO_CONTRACT_ROUTE =
  "The Osmosis swap contract has no route for this pair. Signing would send the tokens, the packet would be rejected, and the funds would come back. The swap stays unsigned.";

describe("what gets signed", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-05T12:00:00Z"));
  });

  it("writes the 0.1.2 memo and MsgTransfer for ATOM on the Hub into OSMO", async () => {
    const result = await planSwap(swap({}));
    expect(result.error).toBeNull();
    expect(result.best?.blockedReason).toBeNull();
    expect(result.best?.plan.memo).toBe(ATOM_TO_OSMO_MEMO);
    expect(
      JSON.stringify(
        buildTransferMsgFromPlan({ view: result.best!, sender: HUB_ADDRESS, amountBaseUnits: "1000000" }),
      ),
    ).toBe(ATOM_TO_OSMO_MSG);
    // Priced on the contract's own route.
    expect(result.quote?.outputAmount).toBe("4000000");
    expect(result.quoteBlockedCode).toBeNull();
    expect(result.venueInputDenom).toBe(OSMO_ATOM);
    expect(result.venueOutputDenom).toBe("uosmo");
  });

  it("writes the 0.1.2 contract call for OSMO into ATOM delivered on the Hub", async () => {
    const result = await planSwap(
      swap({
        sourceChainId: "osmosis-1",
        destChainId: "cosmoshub-4",
        inputDenom: "uosmo",
        destDenom: "uatom",
        amountBaseUnits: "63000000",
        sender: OSMO_ADDRESS,
        recipient: HUB_ADDRESS,
      }),
    );
    expect(result.best?.blockedReason).toBeNull();
    expect(
      JSON.stringify(
        buildTransferMsgFromPlan({ view: result.best!, sender: OSMO_ADDRESS, amountBaseUnits: "63000000" }),
      ),
    ).toBe(OSMO_TO_ATOM_MSG);
  });

  it("writes the 0.1.2 MsgTransfer for a plain Hub to Osmosis transfer", async () => {
    const result = await planTransfer(
      transfer({
        sourceChainId: "cosmoshub-4",
        inputDenom: "uatom",
        sender: HUB_ADDRESS,
      }),
    );
    expect(result.best?.blockedReason).toBeNull();
    expect(result.best?.plan.outputDenom).toBe(OSMO_ATOM);
    expect(
      JSON.stringify(
        buildTransferMsgFromPlan({ view: result.best!, sender: HUB_ADDRESS, amountBaseUnits: "1000000" }),
      ),
    ).toBe(HUB_TO_OSMO_TRANSFER_MSG);
  });
});

/* -------------------------------------------------------------------------- *
 * Canonical channels on a fresh install
 * -------------------------------------------------------------------------- */

describe("canonical channels with fresh storage", () => {
  it("sends USDC.inj from Injective to Osmosis over channel-8, arriving as ibc/794C…", async () => {
    const result = await planTransfer(transfer({}));
    const best = result.best!;
    expect(best.blockedReason).toBeNull();
    expect(best.plan.hops.map((hop) => hop.channelId)).toEqual(["channel-8"]);
    expect(best.candidate.links[0]?.counterpartyChannelId).toBe("channel-122");
    expect(best.plan.outputDenom).toBe(OSMO_USDC_INJ);
    expect(best.hops[0]?.channelVerified).toBe(true);
    expect(best.warnings.some((w) => /not been verified/.test(w))).toBe(false);
  });

  it("unwinds Noble USDC from Osmosis to Noble over channel-750", async () => {
    const result = await planTransfer(
      transfer({
        sourceChainId: "osmosis-1",
        destChainId: "noble-1",
        inputDenom: OSMO_USDC_N,
        sender: OSMO_ADDRESS,
        recipient: NOBLE_ADDRESS,
      }),
    );
    const best = result.best!;
    expect(best.blockedReason).toBeNull();
    expect(best.plan.hops.map((hop) => hop.channelId)).toEqual(["channel-750"]);
    expect(best.plan.outputDenom).toBe("uusdc");
  });

  it("checks the light client on both ends before offering the plan", async () => {
    await planTransfer(transfer({}));
    const statuses = requests(/\/ibc\/core\/client\/v1\/client_status\//).map(
      (url) => `${url.origin}${url.pathname}`,
    );
    expect(statuses).toEqual(
      expect.arrayContaining([
        "https://lcd-injective.keplr.app/ibc/core/client/v1/client_status/07-tendermint-19",
        "https://lcd-osmosis.keplr.app/ibc/core/client/v1/client_status/07-tendermint-1703",
      ]),
    );
  });

  it("answers a second plan from this session's checks", async () => {
    await planTransfer(transfer({}));
    const before = requests(/client_status/).length;
    const again = await planTransfer(transfer({ amountBaseUnits: "2000000" }));
    expect(again.best?.blockedReason).toBeNull();
    expect(requests(/client_status/).length).toBe(before);
  });

  it("prefers canonical channel-8 over a cached channel-5 whose client expired", async () => {
    store.set("zunia.channelRoutes", {
      version: 1,
      routes: [
        {
          sourceChainId: "injective-1",
          destChainId: "osmosis-1",
          channelId: "channel-5",
          counterpartyChannelId: "channel-109",
          verifiedAt: Date.now(),
          source: "discovered",
        },
      ],
    });
    const result = await planTransfer(transfer({}));
    expect(result.best?.plan.hops[0]?.channelId).toBe("channel-8");
    expect(result.best?.blockedReason).toBeNull();
    // channel-5 was never even asked about: the graph did not offer it.
    expect(requests(/\/channels\/channel-5\//)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- *
 * Expired clients
 * -------------------------------------------------------------------------- */

describe("an expired light client", () => {
  it("drops a canonical channel whose far client expired and says why, naming both chains", async () => {
    world.channels["noble-1"]![0]!.clientStatus = "Expired";
    const result = await planTransfer(
      transfer({
        sourceChainId: "osmosis-1",
        destChainId: "noble-1",
        inputDenom: "uosmo",
        sender: OSMO_ADDRESS,
        recipient: NOBLE_ADDRESS,
      }),
    );
    expect(result.best).toBeNull();
    expect(result.warnings[0]).toBe(
      "No usable transfer channel from Osmosis to Noble is known, and reading the channel lists of Osmosis and Noble turned up none. Enter the channel by hand if you know it.",
    );
    expect(result.warnings[1]).toBe(
      "Zunia will not use channel-750 from Osmosis to Noble. Its light client on Noble is expired, so nothing sent over it can arrive.",
    );
  });

  it("blocks Noble USDC on Osmosis when the channel it must unwind by has expired", async () => {
    // A voucher leaves by the channel it arrived on, so the planner puts
    // channel-750 back on the path whatever the graph says. One check, then
    // the plan is blocked rather than planned again.
    world.channels["noble-1"]![0]!.clientStatus = "Expired";
    const result = await planTransfer(
      transfer({
        sourceChainId: "osmosis-1",
        destChainId: "noble-1",
        inputDenom: OSMO_USDC_N,
        sender: OSMO_ADDRESS,
        recipient: NOBLE_ADDRESS,
      }),
    );
    expect(result.best?.plan.hops[0]?.channelId).toBe("channel-750");
    expect(result.best?.blockedReason).toBe(
      "Zunia will not use channel-750 from Osmosis to Noble. Its light client on Noble is expired, so nothing sent over it can arrive.",
    );
    expect(requests(/client_status\/07-tendermint-0$/)).toHaveLength(1);
  });

  it("still unwinds a voucher over the non-canonical channel it arrived by", async () => {
    // Only channel-122 is canonical for the pair, but INJ that came over
    // channel-118 can only go home that way; any other channel double-wraps it.
    const result = await planTransfer(
      transfer({
        sourceChainId: "osmosis-1",
        destChainId: "injective-1",
        inputDenom: OSMO_INJ_118,
        sender: OSMO_ADDRESS,
        recipient: INJ_ADDRESS,
      }),
    );
    expect(result.best?.plan.hops.map((hop) => hop.channelId)).toEqual(["channel-118"]);
    expect(result.best?.plan.outputDenom).toBe("inj");
    expect(result.best?.blockedReason).toBeNull();
  });

  it("blocks a voucher whose way home has an expired client, rather than double-wrapping it", async () => {
    const result = await planTransfer(
      transfer({
        sourceChainId: "osmosis-1",
        destChainId: "injective-1",
        inputDenom: OSMO_USDC_INJ_109,
        sender: OSMO_ADDRESS,
        recipient: INJ_ADDRESS,
      }),
    );
    expect(result.best?.plan.hops.map((hop) => hop.channelId)).toEqual(["channel-109"]);
    expect(result.best?.blockedReason).toBe(
      "Zunia will not use channel-109 from Osmosis to Injective. Its light client on Osmosis is expired, so nothing sent over it can arrive.",
    );
    expect(result.best?.failedCheck?.verdict).toBe("client-inactive");
  });

  it("never offers a pinned channel with an expired client for signing", async () => {
    const result = await planTransfer(
      transfer({
        manualChannels: [{ fromChainId: "injective-1", toChainId: "osmosis-1", channelId: "channel-5" }],
      }),
    );
    expect(result.best?.plan.hops[0]?.channelId).toBe("channel-5");
    expect(result.best?.blockedReason).toMatch(
      /channel-5 from Injective to Osmosis\. Its light client on Injective is expired/,
    );
    // Structured, so a screen that pinned the route itself can drop the pin.
    expect(result.best?.failedCheck).toMatchObject({
      sourceChainId: "injective-1",
      destChainId: "osmosis-1",
      channelId: "channel-5",
      verdict: "client-inactive",
      usable: false,
    });
  });

  it("never signs a channel id written differently from the one it checked", async () => {
    // The check reads `channel-8` whatever the spelling; the message would carry
    // the spelling. A plan over "8" is refused rather than signed unchecked.
    for (const typed of ["8", "Channel-8", " channel-8 "]) {
      const result = await planTransfer(
        transfer({
          manualChannels: [{ fromChainId: "injective-1", toChainId: "osmosis-1", channelId: typed }],
        }),
      );
      expect(result.best?.plan.hops[0]?.channelId).toBe(typed);
      expect(result.best?.blockedReason).toBe(
        `The route names the channel from Injective to Osmosis as "${typed}", which is not how the chain writes it ("channel-8"), so Zunia will not sign it.`,
      );
      expect(result.best?.failedCheck?.verdict).toBe("rejected");
      // The same pin is applied to every candidate, so no alternative signs it either.
      for (const other of result.alternatives) expect(other.blockedReason).not.toBeNull();
    }
    // Written the chain's way, the same pin is checked and signable.
    const written = await planTransfer(
      transfer({
        manualChannels: [{ fromChainId: "injective-1", toChainId: "osmosis-1", channelId: "channel-8" }],
      }),
    );
    expect(written.best?.blockedReason).toBeNull();
    expect(written.best?.failedCheck).toBeNull();
  });

  it("blocks a swap whose only way out of Osmosis has an expired client", async () => {
    world.channels["noble-1"]![0]!.clientStatus = "Expired";
    const result = await planSwap(
      swap({
        sourceChainId: "osmosis-1",
        destChainId: "noble-1",
        inputDenom: "uosmo",
        destDenom: "uusdc",
        sender: OSMO_ADDRESS,
        recipient: NOBLE_ADDRESS,
      }),
    );
    expect(result.best).toBeNull();
    expect(result.quote).toBeNull();
    expect(result.warnings[0]).toContain("from Osmosis to Noble");
  });
});

/* -------------------------------------------------------------------------- *
 * A chain that does not answer
 * -------------------------------------------------------------------------- */

describe("a client status that cannot be read", () => {
  it("blocks the plan without remembering the answer, and asks again next time", async () => {
    world.override = (chainId, path) =>
      chainId === "osmosis-1" && path.startsWith("/ibc/core/client/v1/client_status/")
        ? respond(503, { code: 14, message: "unavailable", details: [] })
        : null;
    const blocked = await planTransfer(transfer({}));
    expect(blocked.best?.plan.hops[0]?.channelId).toBe("channel-8");
    expect(blocked.best?.blockedReason).toBe(
      "Osmosis did not answer for the light-client status of channel-8 from Injective to Osmosis, so this route stays unsigned for now. Try again in a moment.",
    );
    expect(blocked.best?.failedCheck?.verdict).toBe("inconclusive");

    world.override = null;
    const again = await planTransfer(transfer({ amountBaseUnits: "2000000" }));
    expect(again.best?.blockedReason).toBeNull();
    expect(again.best?.failedCheck).toBeNull();
  });

  it("refuses a channel whose client follows another chain, and plans around it", async () => {
    // The registry's chain id and the client's can part ways (Aura's clients
    // follow xstaxy-1 while the registry says aura_6322-2).
    world.override = (chainId, path) =>
      chainId === "osmosis-1" && path === "/ibc/core/channel/v1/channels/channel-122/ports/transfer/client_state"
        ? respond(200, {
            identified_client_state: {
              client_id: "07-tendermint-1703",
              client_state: { chain_id: "injective-888" },
            },
          })
        : null;
    const result = await planTransfer(transfer({}));
    // Channel-6 is the one other open channel Injective's list names.
    expect(result.best?.plan.hops[0]?.channelId).toBe("channel-6");
    expect(result.best?.blockedReason).toBeNull();
    const pinned = await planTransfer(
      transfer({
        manualChannels: [{ fromChainId: "injective-1", toChainId: "osmosis-1", channelId: "channel-8" }],
      }),
    );
    expect(pinned.best?.blockedReason).toBe(
      "Zunia will not use channel-8 from Injective to Osmosis. Its light client on Osmosis follows Injective (Testnet), not Injective.",
    );
    expect(pinned.best?.failedCheck?.verdict).toBe("rejected");
  });
});

/* -------------------------------------------------------------------------- *
 * Client status the node will not serve
 * -------------------------------------------------------------------------- */

describe("a node without the client-status route", () => {
  it("still uses the canonical channel, with a warning", async () => {
    world.noStatusRoute.add("injective-1");
    const result = await planTransfer(transfer({}));
    expect(result.best?.plan.hops[0]?.channelId).toBe("channel-8");
    expect(result.best?.blockedReason).toBeNull();
    expect(result.best?.warnings.join(" ")).toMatch(
      /Injective does not report light-client status.*canonical channel/,
    );
  });

  it("refuses any other channel it cannot confirm", async () => {
    world.noStatusRoute.add("injective-1");
    const result = await planTransfer(
      transfer({
        manualChannels: [{ fromChainId: "injective-1", toChainId: "osmosis-1", channelId: "channel-6" }],
      }),
    );
    expect(result.best?.plan.hops[0]?.channelId).toBe("channel-6");
    expect(result.best?.blockedReason).toMatch(
      /Injective does not report light-client status, so Zunia cannot confirm channel-6 from Injective to Osmosis is live/,
    );
  });
});

/* -------------------------------------------------------------------------- *
 * Discovery, as a fallback
 * -------------------------------------------------------------------------- */

describe("discovery", () => {
  it("walks the source chain once when no channel is known, then plans over what it found", async () => {
    // The registry names no Safrochain and Hub channel, so only discovery can.
    const result = await planTransfer(
      transfer({
        sourceChainId: "safrochain-1",
        destChainId: "cosmoshub-4",
        inputDenom: "usaf",
        sender: SAFRO_ADDRESS,
        recipient: HUB_ADDRESS,
      }),
    );
    expect(result.best?.plan.hops[0]?.channelId).toBe("channel-3");
    expect(result.best?.blockedReason).toBeNull();
    expect(requests(/^\/ibc\/core\/channel\/v1\/channels$/).map((url) => url.origin)).toEqual([
      "https://api.safrochain.network",
    ]);
  });

  it("does not walk the same chain twice in a session when it finds nothing", async () => {
    world.channels["noble-1"]![0]!.clientStatus = "Expired";
    const input = transfer({
      sourceChainId: "osmosis-1",
      destChainId: "noble-1",
      inputDenom: "uosmo",
      sender: OSMO_ADDRESS,
      recipient: NOBLE_ADDRESS,
    });
    await planTransfer(input);
    await planTransfer({ ...input, amountBaseUnits: "5" });
    // Osmosis names only the channel already ruled out, so Noble's list is
    // read as well; each once, and not again for the second plan.
    expect(requests(/^\/ibc\/core\/channel\/v1\/channels$/).map((url) => url.origin)).toEqual([
      "https://lcd-osmosis.keplr.app",
      "https://lcd-noble.keplr.app",
    ]);
  });

  /**
   * Archway's Osmosis channel is not in the registry table (the registry does
   * not tag it preferred), and Osmosis's own list never reaches it: the first
   * thousand rows there are interchain-account channels. Only Archway's list
   * names it.
   */
  function addArchway(): void {
    world.channels["archway-1"] = [channel("channel-1", "osmosis-1", "channel-1429", "07-tendermint-5")];
    world.channels["osmosis-1"]!.push(
      channel("channel-1429", "archway-1", "channel-1", "07-tendermint-2001"),
    );
    world.unlisted.add("osmosis-1:channel-1429");
  }

  it("reads the arriving chain's list when the leaving chain's names nothing", async () => {
    addArchway();
    const result = await planTransfer(
      transfer({
        sourceChainId: "osmosis-1",
        destChainId: "archway-1",
        inputDenom: "uosmo",
        sender: OSMO_ADDRESS,
        recipient: ARCHWAY_ADDRESS,
      }),
    );
    expect(result.best?.plan.hops.map((hop) => hop.channelId)).toEqual(["channel-1429"]);
    expect(result.best?.blockedReason).toBeNull();
    expect(requests(/^\/ibc\/core\/channel\/v1\/channels$/).map((url) => url.origin)).toEqual([
      "https://lcd-osmosis.keplr.app",
      "https://api.mainnet.archway.io",
    ]);
  });

  it("names the list it could not read, and reads it again on the next plan", async () => {
    addArchway();
    world.override = (chainId, path) =>
      chainId === "archway-1" && path === "/ibc/core/channel/v1/channels"
        ? respond(500, { code: 13, message: "node is syncing", details: [] })
        : null;
    const input = transfer({
      sourceChainId: "osmosis-1",
      destChainId: "archway-1",
      inputDenom: "uosmo",
      sender: OSMO_ADDRESS,
      recipient: ARCHWAY_ADDRESS,
    });
    const failed = await planTransfer(input);
    expect(failed.best).toBeNull();
    expect(failed.warnings[0]).toBe(
      "No usable transfer channel from Osmosis to Archway is known, and reading Osmosis's channel list turned up none. Archway's channel list could not be read. Could not reach Archway. Its public endpoint is down or slow; try again in a moment. Enter the channel by hand if you know it.",
    );

    world.override = null;
    const recovered = await planTransfer({ ...input, amountBaseUnits: "5" });
    expect(recovered.best?.plan.hops.map((hop) => hop.channelId)).toEqual(["channel-1429"]);
    expect(recovered.best?.blockedReason).toBeNull();
  });

  it("finds the way out of the venue for a swap delivered on a chain only it lists", async () => {
    addArchway();
    const result = await planSwap(
      swap({ destChainId: "archway-1", destDenom: "aarch", recipient: ARCHWAY_ADDRESS }),
    );
    expect(result.best?.plan.hops.map((hop) => hop.channelId)).toEqual([
      "channel-141",
      "",
      "channel-1429",
    ]);
    expect(result.best?.blockedReason).toBeNull();
    // Planned and checked; the contract's table has no ATOM to ARCH route.
    expect(result.quoteBlockedCode).toBe("no-contract-route");
  });
});

/* -------------------------------------------------------------------------- *
 * The contract's route table, and the variant invariant
 * -------------------------------------------------------------------------- */

describe("quote blocks", () => {
  it("says no-contract-route for ATOM on the Hub into USDC.inj on Osmosis", async () => {
    const result = await planSwap(swap({ destDenom: OSMO_USDC_INJ }));
    expect(result.best?.blockedReason).toBeNull();
    expect(result.best?.plan.memo).toBe(ATOM_TO_USDC_INJ_MEMO);
    expect(result.quote).toBeNull();
    expect(result.quoteBlockedCode).toBe("no-contract-route");
    expect(result.quoteBlockedReason).toBe(NO_CONTRACT_ROUTE);
  });

  it("names USDC.inj from Injective as ibc/794C… on Osmosis, which the caller expects", async () => {
    const result = await planSwap(
      swap({
        sourceChainId: "injective-1",
        inputDenom: USDC_INJ,
        sender: INJ_ADDRESS,
        expectedVenueInputDenom: OSMO_USDC_INJ,
        expectedVenueOutputDenom: "uosmo",
      }),
    );
    expect(result.best?.plan.hops[0]?.channelId).toBe("channel-8");
    expect(result.best?.blockedReason).toBeNull();
    expect(result.venueInputDenom).toBe(OSMO_USDC_INJ);
    // The pair is real but the contract cannot route it.
    expect(result.quoteBlockedCode).toBe("no-contract-route");
  });

  it("blocks a plan that would sell a different variant than the one picked", async () => {
    // What the same USDC is called on Osmosis after crossing expired channel-109.
    const viaExpired = await ibcDenomHash("transfer/channel-109", USDC_INJ);
    expect(viaExpired.startsWith("ibc/4AF599D4")).toBe(true);
    const result = await planSwap(
      swap({
        sourceChainId: "injective-1",
        inputDenom: USDC_INJ,
        sender: INJ_ADDRESS,
        expectedVenueInputDenom: viaExpired,
      }),
    );
    expect(result.quoteBlockedCode).toBe("venue-denom-mismatch");
    expect(result.best?.blockedReason).toMatch(/different variant/);
    expect(result.quoteBlockedReason).toContain(OSMO_USDC_INJ);
    expect(result.quote).toBeNull();
    expect(result.venueInputDenom).toBeNull();
    expect(result.venueOutputDenom).toBeNull();
    // Refused before the contract was asked to route it.
    expect(requests(new RegExp(`/contract/${ROUTER}/smart/`))).toEqual([]);
  });

  it("blocks the catalog's lowercase spelling of Injective USDC, which names another denom", async () => {
    // The catalog stores erc20 addresses lowercased. That string has no supply
    // on Injective, and over channel-122 it hashes to ibc/D3B2A035…, not 794C….
    const lowercase = USDC_INJ.toLowerCase();
    const result = await planSwap(
      swap({
        sourceChainId: "injective-1",
        inputDenom: lowercase,
        sender: INJ_ADDRESS,
        expectedVenueInputDenom: OSMO_USDC_INJ,
        expectedVenueOutputDenom: "uosmo",
      }),
    );
    expect(result.best?.plan.hops[0]?.channelId).toBe("channel-8");
    expect(result.quoteBlockedCode).toBe("venue-denom-mismatch");
    expect(result.quoteBlockedReason).toContain(await ibcDenomHash("transfer/channel-122", lowercase));
    expect(result.best?.blockedReason).toMatch(/different variant/);
    expect(result.venueInputDenom).toBeNull();
  });

  it("blocks a delivery to the origin chain whose venue output is not the expected denom", async () => {
    const deliverOnInjective = swap({
      sourceChainId: "osmosis-1",
      destChainId: "injective-1",
      inputDenom: "uosmo",
      destDenom: USDC_INJ,
      sender: OSMO_ADDRESS,
      recipient: INJ_ADDRESS,
    });

    const matching = await planSwap({ ...deliverOnInjective, expectedVenueOutputDenom: OSMO_USDC_INJ });
    expect(matching.best?.plan.hops.map((hop) => hop.channelId)).toEqual(["", "channel-122"]);
    expect(matching.quoteBlockedCode).toBe("no-contract-route");

    const other = await planSwap({ ...deliverOnInjective, expectedVenueOutputDenom: OSMO_USDC_N });
    expect(other.quoteBlockedCode).toBe("venue-denom-mismatch");
    expect(other.best?.blockedReason).toMatch(/buys ibc\/794C.*not ibc\/498A/);
  });

  it("gives a requote the same codes as the plan", async () => {
    const requote = (venueInputDenom: string, venueOutputDenom: string) =>
      requoteSwap({
        venueChainId: "osmosis-1",
        venueContract: XCS,
        venueInputDenom,
        venueOutputDenom,
        amountBaseUnits: "1000000",
        slippagePercent: 1,
      });
    const priced = await requote(OSMO_ATOM, "uosmo");
    expect(priced.quote?.outputAmount).toBe("4000000");
    expect(priced.code).toBeNull();
    const refused = await requote("uosmo", OSMO_USDC_INJ);
    expect(refused.quote).toBeNull();
    expect(refused.code).toBe("no-contract-route");
    expect(refused.error).toBe(NO_CONTRACT_ROUTE);
  });

  it("stops when the caller cancels", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await planSwap(swap({ signal: controller.signal }));
    expect(result.best).toBeNull();
    expect(result.error).toBe("Cancelled.");
  });
});
