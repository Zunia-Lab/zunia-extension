import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChannelDirectory, type ChannelLink } from "@zunialab/interchain";

import { EXPLORER_TX_URLS, explorerTxUrl } from "../../config/interchain";
import { findCatalogEntry } from "../chain-catalog";
import { IBC_CHANNELS_COMMIT } from "../ibc-channels.generated";
import {
  CANONICAL_CHANNEL_ROUTES,
  canonicalChannelIds,
  clearInterchainCaches,
  isCanonicalChannel,
  loadRouteRegistry,
  readChannelClient,
  saveRouteRegistry,
} from "../interchain";
import {
  buildTransferMsgFromPlan,
  channelDirectory,
  checkChannelHop,
  pathHopViews,
  resetChannelChecks,
  routableLinks,
  verifyChannelHop,
  type RoutePlanView,
} from "../route-plan";

/**
 * The wire shape of the one message a route signs.
 *
 * `buildTransferMsgFromPlan` hands the plan to the engine's ICS20 builder, which
 * writes the proto-JSON zunia-core's `msg_from_proto_json` parses. A field
 * renamed there fails on chain as an opaque decode error after the user has
 * approved, which is exactly the failure these assertions exist to catch.
 */
function view(overrides: {
  kind?: "transfer" | "forward" | "swap";
  memo?: string;
  receiver?: string;
  inputDenom?: string;
}): RoutePlanView {
  return {
    plan: {
      sourceChainId: "safrochain-1",
      destChainId: "osmosis-1",
      inputDenom: overrides.inputDenom ?? "usafro",
      outputDenom: "uosmo",
      hops: [
        {
          chainId: "safrochain-1",
          channelId: "channel-7",
          port: "transfer",
          counterpartyChainId: "osmosis-1",
          kind: overrides.kind ?? "transfer",
        },
      ],
      memo: overrides.memo ?? "",
      warnings: [],
      estimatedDurationSeconds: 60,
      requiresPfm: false,
      requiresIbcHooks: false,
    },
    receiver: overrides.receiver ?? "osmo1receiver",
    hops: [],
    warnings: [],
    candidate: null as never,
    memo: null as never,
    blockedReason: null,
  } as unknown as RoutePlanView;
}

describe("buildTransferMsgFromPlan", () => {
  it("emits the proto-JSON field names the kernel parses", () => {
    const msg = buildTransferMsgFromPlan({
      view: view({}),
      sender: "addr_safro1sender",
      amountBaseUnits: "1000000",
    });

    expect(msg.typeUrl).toBe("/ibc.applications.transfer.v1.MsgTransfer");
    expect(Object.keys(msg.value).sort()).toEqual([
      "memo",
      "receiver",
      "sender",
      "source_channel",
      "source_port",
      "timeout_height",
      "timeout_timestamp",
      "token",
    ]);
    expect(msg.value.source_port).toBe("transfer");
    expect(msg.value.source_channel).toBe("channel-7");
    expect(msg.value.token).toEqual({ denom: "usafro", amount: "1000000" });
    expect(msg.value.sender).toBe("addr_safro1sender");
    expect(msg.value.timeout_height).toEqual({
      revision_number: "0",
      revision_height: "0",
    });
  });

  it("always sets a timeout, because a packet with none is never refunded", () => {
    const before = BigInt(Date.now()) * 1_000_000n;
    const msg = buildTransferMsgFromPlan({
      view: view({}),
      sender: "addr_safro1sender",
      amountBaseUnits: "1",
    });
    const timeout = BigInt(String(msg.value.timeout_timestamp));
    expect(timeout).toBeGreaterThan(before);
    // 10 minutes of nanoseconds, plus whatever the clock advanced during the call.
    expect(timeout - before).toBeGreaterThanOrEqual(10n * 60n * 1_000_000_000n);
  });

  it("addresses the packet to the plan's receiver, not to the final recipient", () => {
    // ibc-hooks only runs when the ICS20 receiver is "" or the contract, so for
    // a swap the receiver is the crosschain-swaps contract and the real
    // recipient lives inside the memo.
    const contract = "osmo1contract";
    const msg = buildTransferMsgFromPlan({
      view: view({
        receiver: contract,
        memo: JSON.stringify({ wasm: { contract, msg: { osmosis_swap: {} } } }),
      }),
      sender: "addr_safro1sender",
      amountBaseUnits: "5",
    });
    expect(msg.value.receiver).toBe(contract);
  });

  it("carries the memo verbatim", () => {
    const memo = JSON.stringify({
      forward: { receiver: "pfm", port: "transfer", channel: "channel-1" },
    });
    const msg = buildTransferMsgFromPlan({
      view: view({ memo }),
      sender: "addr_safro1sender",
      amountBaseUnits: "5",
    });
    expect(msg.value.memo).toBe(memo);
  });

  it("refuses a swap hop that does not carry an osmosis_swap execute", () => {
    expect(() =>
      buildTransferMsgFromPlan({
        view: view({ kind: "swap" }),
        sender: "addr_safro1sender",
        amountBaseUnits: "5",
      }),
    ).toThrow(/no transfer/i);
  });

  it("signs a venue-origin swap as one contract call with the input coin", () => {
    const contract = "osmo1contract";
    const swap = {
      output_denom: "ibc/ATOM",
      slippage: { twap: { slippage_percentage: "1", window_seconds: 10 } },
      receiver: "cosmos1recipient",
      on_failed_delivery: { local_recovery_addr: "osmo1recovery" },
      next_memo: null,
    };
    const msg = buildTransferMsgFromPlan({
      view: view({
        kind: "swap",
        inputDenom: "uosmo",
        receiver: contract,
        memo: JSON.stringify({ wasm: { contract, msg: { osmosis_swap: swap } } }),
      }),
      sender: "osmo1sender",
      amountBaseUnits: "63000000",
    });
    expect(msg.typeUrl).toBe("/cosmwasm.wasm.v1.MsgExecuteContract");
    expect(msg.value.sender).toBe("osmo1sender");
    expect(msg.value.contract).toBe(contract);
    expect(msg.value.funds).toEqual([{ denom: "uosmo", amount: "63000000" }]);
    const body = JSON.parse(Buffer.from(String(msg.value.msg), "base64").toString("utf8"));
    expect(body).toEqual({ osmosis_swap: swap });
  });
});

describe("explorerTxUrl", () => {
  it("fills the chain's registry template and encodes the hash", () => {
    expect(explorerTxUrl("osmosis-1", "ABC123")).toBe(
      "https://www.mintscan.io/osmosis/transactions/ABC123",
    );
    expect(explorerTxUrl("safrochain-1", "a/b")).toBe(
      "https://explorer.safrochain.com/tx/a%2Fb",
    );
  });

  it("returns null rather than a guessed explorer domain", () => {
    // A link that 404s or points at somebody else's chain is worse than plain
    // selectable text.
    expect(explorerTxUrl("unknown-1", "ABC")).toBeNull();
  });

  it("lists only chains the catalog knows, each with one https template", () => {
    for (const [chainId, template] of Object.entries(EXPLORER_TX_URLS)) {
      expect(findCatalogEntry(chainId), chainId).toBeDefined();
      expect(template.startsWith("https://"), chainId).toBe(true);
      expect(template.split("{hash}").length, chainId).toBe(2);
    }
  });
});

describe("pathHopViews", () => {
  it("names each leg and calls only a checked channel open", () => {
    const hops = pathHopViews([
      {
        sourceChainId: "cosmoshub-4",
        destChainId: "osmosis-1",
        channelId: "channel-141",
        port: "transfer",
        source: "verified",
        state: "open",
      },
      {
        sourceChainId: "osmosis-1",
        destChainId: "juno-1",
        channelId: "channel-42",
        port: "transfer",
        source: "seed",
        state: "unknown",
      },
    ]);
    expect(
      hops.map((hop) => [
        hop.index,
        hop.kind,
        hop.chainId,
        hop.counterpartyChainId,
        hop.channelId,
        hop.channelVerified,
      ]),
    ).toEqual([
      [0, "transfer", "cosmoshub-4", "osmosis-1", "channel-141", true],
      [1, "forward", "osmosis-1", "juno-1", "channel-42", false],
    ]);
    expect(hops.map((hop) => hop.channelSource)).toEqual(["discovered", "seed"]);
  });
});

/* -------------------------------------------------------------------------- *
 * The bytes a plan signs
 * -------------------------------------------------------------------------- */

/**
 * The messages 0.1.2 wrote for the fixtures above, captured with the clock
 * frozen at 2026-10-05T12:00:00Z (the timeout is ten minutes later). Channel
 * checks change which channel a plan uses, never how a plan becomes a message.
 */
const FORWARD_MEMO = '{"forward":{"receiver":"pfm","port":"transfer","channel":"channel-1"}}';

const XCS_MEMO =
  '{"wasm":{"contract":"osmo1contract","msg":{"osmosis_swap":{"output_denom":"uosmo",' +
  '"slippage":{"twap":{"slippage_percentage":"1","window_seconds":10}},' +
  '"receiver":"osmo1receiver","on_failed_delivery":{"local_recovery_addr":"osmo1recovery"},' +
  '"next_memo":null}}}}';

const VENUE_MEMO =
  '{"wasm":{"contract":"osmo1contract","msg":{"osmosis_swap":{"output_denom":"ibc/ATOM",' +
  '"slippage":{"twap":{"slippage_percentage":"1","window_seconds":10}},' +
  '"receiver":"cosmos1recipient","on_failed_delivery":{"local_recovery_addr":"osmo1recovery"},' +
  '"next_memo":null}}}}';

function transferBytes(amount: string, receiver: string, memo: string): string {
  return (
    '{"typeUrl":"/ibc.applications.transfer.v1.MsgTransfer","value":{"source_port":"transfer",' +
    `"source_channel":"channel-7","token":{"denom":"usafro","amount":"${amount}"},` +
    `"sender":"addr_safro1sender","receiver":"${receiver}",` +
    '"timeout_height":{"revision_number":"0","revision_height":"0"},' +
    `"timeout_timestamp":"1791202200000000000","memo":${JSON.stringify(memo)}}}`
  );
}

const VENUE_BYTES =
  '{"typeUrl":"/cosmwasm.wasm.v1.MsgExecuteContract","value":{"sender":"osmo1sender",' +
  '"contract":"osmo1contract","msg":"' +
  "eyJvc21vc2lzX3N3YXAiOnsib3V0cHV0X2Rlbm9tIjoiaWJjL0FUT00iLCJzbGlwcGFnZSI6eyJ0d2FwIjp7InNsaXBw" +
  "YWdlX3BlcmNlbnRhZ2UiOiIxIiwid2luZG93X3NlY29uZHMiOjEwfX0sInJlY2VpdmVyIjoiY29zbW9zMXJlY2lwaWVu" +
  "dCIsIm9uX2ZhaWxlZF9kZWxpdmVyeSI6eyJsb2NhbF9yZWNvdmVyeV9hZGRyIjoib3NtbzFyZWNvdmVyeSJ9LCJuZXh0" +
  "X21lbW8iOm51bGx9fQ==" +
  '","funds":[{"denom":"uosmo","amount":"63000000"}]}}';

describe("buildTransferMsgFromPlan, byte for byte", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-05T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function bytes(args: Parameters<typeof buildTransferMsgFromPlan>[0]): string {
    return JSON.stringify(buildTransferMsgFromPlan(args));
  }

  it("writes the same MsgTransfer as 0.1.2 with no memo, a forward memo and a swap memo", () => {
    expect(
      bytes({ view: view({}), sender: "addr_safro1sender", amountBaseUnits: "1000000" }),
    ).toBe(transferBytes("1000000", "osmo1receiver", ""));
    expect(
      bytes({ view: view({ memo: FORWARD_MEMO }), sender: "addr_safro1sender", amountBaseUnits: "5" }),
    ).toBe(transferBytes("5", "osmo1receiver", FORWARD_MEMO));
    expect(
      bytes({
        view: view({ receiver: "osmo1contract", memo: XCS_MEMO }),
        sender: "addr_safro1sender",
        amountBaseUnits: "5",
      }),
    ).toBe(transferBytes("5", "osmo1contract", XCS_MEMO));
  });

  it("writes the same MsgExecuteContract as 0.1.2 for a venue-origin swap", () => {
    expect(
      bytes({
        view: view({ kind: "swap", inputDenom: "uosmo", receiver: "osmo1contract", memo: VENUE_MEMO }),
        sender: "osmo1sender",
        amountBaseUnits: "63000000",
      }),
    ).toBe(VENUE_BYTES);
  });
});

/* -------------------------------------------------------------------------- *
 * Canonical channels
 * -------------------------------------------------------------------------- */

/** Each direction as `source channel > dest counterparty`, so failures read as routes. */
function rows(): string[] {
  return CANONICAL_CHANNEL_ROUTES.map(
    (route) =>
      `${route.sourceChainId} ${route.channelId} > ${route.destChainId} ${route.counterpartyChannelId}`,
  );
}

describe("canonical channel seeds", () => {
  it("are read from a pinned chain-registry commit", () => {
    expect(IBC_CHANNELS_COMMIT).toMatch(/^[0-9a-f]{40}$/);
  });

  it("hold the pairs the audit verified live, in both directions", () => {
    expect(rows()).toEqual(
      expect.arrayContaining([
        "injective-1 channel-8 > osmosis-1 channel-122",
        "osmosis-1 channel-122 > injective-1 channel-8",
        "noble-1 channel-1 > osmosis-1 channel-750",
        "osmosis-1 channel-750 > noble-1 channel-1",
        "axelar-dojo-1 channel-3 > osmosis-1 channel-208",
        "osmosis-1 channel-208 > axelar-dojo-1 channel-3",
        "cosmoshub-4 channel-141 > osmosis-1 channel-0",
        "osmosis-1 channel-0 > cosmoshub-4 channel-141",
      ]),
    );
  });

  it("leave out the parallel Osmosis and Injective channels whose clients expired", () => {
    const toInjective = CANONICAL_CHANNEL_ROUTES.filter(
      (route) => route.sourceChainId === "osmosis-1" && route.destChainId === "injective-1",
    ).map((route) => route.channelId);
    expect(toInjective).toEqual(["channel-122"]);
    expect(canonicalChannelIds("injective-1", "osmosis-1")).toEqual(["channel-8"]);
    expect(isCanonicalChannel("osmosis-1", "injective-1", "channel-109")).toBe(false);
  });

  it("name each channel end once, so no channel is claimed for two destinations", () => {
    const ends = CANONICAL_CHANNEL_ROUTES.map((route) => `${route.sourceChainId} ${route.channelId}`);
    expect(new Set(ends).size).toBe(ends.length);
  });

  it("are unchecked seeds between catalog mainnets, every row mirrored", () => {
    const keys = new Set(rows());
    for (const route of CANONICAL_CHANNEL_ROUTES) {
      expect(route.source).toBe("seed");
      expect(route.verifiedAt).toBe(0);
      expect(findCatalogEntry(route.sourceChainId)?.network, route.sourceChainId).toBe("mainnet");
      expect(findCatalogEntry(route.destChainId)?.network, route.destChainId).toBe("mainnet");
      expect(
        keys.has(
          `${route.destChainId} ${route.counterpartyChannelId} > ${route.sourceChainId} ${route.channelId}`,
        ),
      ).toBe(true);
    }
  });
});

/* -------------------------------------------------------------------------- *
 * The channel graph
 * -------------------------------------------------------------------------- */

/** Storage and a two-chain LCD: Injective and Osmosis, live channel numbers. */
let stored: Map<string, unknown>;
let clientStatus: Record<string, string>;

const LCD: Record<string, string> = {
  "https://lcd-injective.keplr.app": "injective-1",
  "https://lcd-osmosis.keplr.app": "osmosis-1",
};

/** chain → channel → [counterparty chain, counterparty channel, client]. */
const CHANNELS: Record<string, Record<string, readonly [string, string, string]>> = {
  "injective-1": {
    "channel-5": ["osmosis-1", "channel-109", "07-tendermint-11"],
    "channel-8": ["osmosis-1", "channel-122", "07-tendermint-19"],
  },
  "osmosis-1": {
    "channel-109": ["injective-1", "channel-5", "07-tendermint-1617"],
    "channel-122": ["injective-1", "channel-8", "07-tendermint-1703"],
  },
};

function answer(status: number, body: unknown): Response {
  return {
    ok: status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function lcd(url: URL): Response {
  const chainId = LCD[url.origin];
  const channels = chainId ? CHANNELS[chainId]! : {};
  const byClient = Object.values(channels).find(([, , client]) => url.pathname.endsWith(`/${client}`));
  let match = url.pathname.match(/\/channels\/(channel-\d+)\/ports\/transfer(\/client_state)?$/);
  if (match) {
    const row = channels[match[1]!];
    if (!row) return answer(404, { code: 5, message: "channel not found" });
    if (match[2]) {
      return answer(200, {
        identified_client_state: { client_id: row[2], client_state: { chain_id: row[0] } },
      });
    }
    return answer(200, {
      channel: {
        state: "STATE_OPEN",
        counterparty: { port_id: "transfer", channel_id: row[1] },
        connection_hops: [`connection-${row[2]}`],
      },
    });
  }
  match = url.pathname.match(/\/connections\/connection-(.+)$/);
  if (match) return answer(200, { connection: { client_id: match[1] } });
  if (url.pathname.includes("/client_states/") && byClient) {
    return answer(200, { client_state: { chain_id: byClient[0] } });
  }
  if (url.pathname.includes("/client_status/") && byClient) {
    return answer(200, { status: clientStatus[byClient[2]] ?? "Active" });
  }
  return answer(501, { code: 12, message: "Not Implemented" });
}

/** What discovery cached in 0.1.2: the expired pair, found first by channel number. */
function cacheExpiredPair(): void {
  const now = Date.now();
  stored.set("zunia.channelRoutes", {
    version: 1,
    routes: [
      {
        sourceChainId: "injective-1",
        destChainId: "osmosis-1",
        channelId: "channel-5",
        counterpartyChannelId: "channel-109",
        verifiedAt: now,
        source: "discovered",
      },
      {
        sourceChainId: "osmosis-1",
        destChainId: "injective-1",
        channelId: "channel-109",
        counterpartyChannelId: "channel-5",
        verifiedAt: now,
        source: "discovered",
      },
    ],
  });
}

function channelsTo(links: readonly ChannelLink[], destChainId: string): string[] {
  return links.filter((link) => link.destChainId === destChainId).map((link) => link.channelId);
}

describe("the channel graph against two chains", () => {
  beforeEach(() => {
    stored = new Map<string, unknown>([["zunia.settings", { liveBalances: true }]]);
    clientStatus = { "07-tendermint-11": "Expired", "07-tendermint-1617": "Expired" };
    vi.stubGlobal("browser", {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: stored.get(key) }),
          set: async (patch: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(patch)) stored.set(k, v);
          },
          remove: async (key: string) => void stored.delete(key),
        },
      },
      permissions: { contains: async () => true },
    });
    vi.stubGlobal("fetch", async (input: string) => lcd(new URL(input)));
    clearInterchainCaches();
    resetChannelChecks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearInterchainCaches();
    resetChannelChecks();
  });

  describe("readChannelClient", () => {
    /** Osmosis answers client_state normally and client_status with `status`/`body`. */
    function statusAnswers(status: number, body: unknown): void {
      vi.stubGlobal("fetch", async (input: string) => {
        const url = new URL(input);
        return url.pathname.includes("/client_status/") ? answer(status, body) : lcd(url);
      });
    }

    it("reads the client and its status", async () => {
      expect(await readChannelClient("osmosis-1", "channel-122", "transfer")).toEqual({
        kind: "ok",
        clientId: "07-tendermint-1703",
        trackedChainId: "injective-1",
        status: "Active",
      });
      expect(await readChannelClient("osmosis-1", "channel-109", "transfer")).toMatchObject({
        kind: "ok",
        status: "Expired",
      });
    });

    it("calls a route the node does not serve unsupported", async () => {
      for (const status of [404, 405, 501]) {
        clearInterchainCaches();
        statusAnswers(status, { code: 12, message: "Not Implemented" });
        expect((await readChannelClient("osmosis-1", "channel-122", "transfer")).kind).toBe(
          "unsupported",
        );
      }
    });

    it("calls anything else unreachable, never an answer", async () => {
      for (const [status, body] of [
        [503, { message: "unavailable" }],
        [400, { message: "bad request" }],
        [200, {}],
        [200, { status: "" }],
      ] as const) {
        clearInterchainCaches();
        statusAnswers(status, body);
        expect((await readChannelClient("osmosis-1", "channel-122", "transfer")).kind).toBe(
          "unreachable",
        );
      }
      // A chain the wallet does not know.
      expect((await readChannelClient("nowhere-1", "channel-0", "transfer")).kind).toBe(
        "unreachable",
      );
    });

    it("throws when live reads are off, so a plan says why instead of guessing", async () => {
      stored.set("zunia.settings", { liveBalances: false });
      clearInterchainCaches();
      await expect(readChannelClient("osmosis-1", "channel-122", "transfer")).rejects.toMatchObject({
        code: "reads-disabled",
      });
    });
  });

  describe("the route cache", () => {
    it("loads the canonical seeds and never writes them back", async () => {
      const registry = await loadRouteRegistry();
      expect(registry.getAll("injective-1", "osmosis-1").map((route) => route.channelId)).toEqual([
        "channel-8",
      ]);
      await saveRouteRegistry(registry);
      const snapshot = stored.get("zunia.channelRoutes") as { routes: unknown[] };
      expect(snapshot.routes).toEqual([]);
    });
  });

  describe("channelDirectory", () => {
    it("prefers canonical channel-8 over a cached channel-5, in both directions", async () => {
      cacheExpiredPair();
      const directory = await channelDirectory();
      expect(channelsTo(directory.from("injective-1"), "osmosis-1")).toEqual(["channel-8"]);
      expect(channelsTo(directory.from("osmosis-1"), "injective-1")).toEqual(["channel-122"]);
    });

    it("keeps a channel the user entered next to the canonical one", async () => {
      stored.set("zunia.channelRoutes", {
        version: 1,
        routes: [
          {
            sourceChainId: "injective-1",
            destChainId: "osmosis-1",
            channelId: "channel-6",
            counterpartyChannelId: "",
            verifiedAt: 0,
            source: "manual",
          },
        ],
      });
      const directory = await channelDirectory();
      expect(channelsTo(directory.from("injective-1"), "osmosis-1").sort()).toEqual([
        "channel-6",
        "channel-8",
      ]);
    });

    it("drops a channel this session found expired", async () => {
      cacheExpiredPair();
      await checkChannelHop("injective-1", "osmosis-1", "channel-8");
      // The client expires; a new session (no checks, no cached LCD bodies) sees it.
      clientStatus["07-tendermint-19"] = "Expired";
      clearInterchainCaches();
      resetChannelChecks();
      expect((await checkChannelHop("injective-1", "osmosis-1", "channel-8")).verdict).toBe(
        "client-inactive",
      );
      const directory = await channelDirectory();
      // channel-8 is ruled out, so the pair falls back to what is left: the
      // cached channel-5, which is checked like any other before signing.
      expect(channelsTo(directory.from("injective-1"), "osmosis-1")).toEqual(["channel-5"]);
    });
  });

  describe("verifyChannelHop", () => {
    it("refuses a channel whose light client expired, though both ends read open", async () => {
      cacheExpiredPair();
      expect(await verifyChannelHop("injective-1", "osmosis-1", "channel-5")).toBe(false);
      const check = await checkChannelHop("injective-1", "osmosis-1", "channel-5");
      expect(check.verdict).toBe("client-inactive");
      expect(check.message).toBe(
        "Zunia will not use channel-5 from Injective to Osmosis. Its light client on Injective is expired, so nothing sent over it can arrive.",
      );
      // The stale discovered row is gone from the cache.
      const registry = await loadRouteRegistry();
      expect(registry.getAll("injective-1", "osmosis-1").map((route) => route.channelId)).toEqual([
        "channel-8",
      ]);
    });

    it("refuses a channel whose far end's client expired", async () => {
      clientStatus = { "07-tendermint-1617": "Expired" };
      const check = await checkChannelHop("injective-1", "osmosis-1", "channel-5");
      expect(check.usable).toBe(false);
      expect(check.message).toContain("Its light client on Osmosis is expired");
    });

    it("confirms the canonical channel and records it as verified", async () => {
      expect(await verifyChannelHop("injective-1", "osmosis-1", "channel-8")).toBe(true);
      const registry = await loadRouteRegistry();
      const row = registry.getAll("injective-1", "osmosis-1")[0]!;
      expect(row.channelId).toBe("channel-8");
      expect(row.source).toBe("discovered");
      expect(row.verifiedAt).toBeGreaterThan(0);
      expect(row.counterpartyChannelId).toBe("channel-122");
    });
  });
});

describe("routableLinks", () => {
  const link = (channelId: string, source: ChannelLink["source"], destChainId = "osmosis-1") => ({
    sourceChainId: "injective-1",
    destChainId,
    channelId,
    port: "transfer",
    source,
    state: "unknown" as const,
  });
  const knowledge = (refused: readonly string[] = []) => ({
    canonical: (source: string, dest: string) =>
      source === "injective-1" && dest === "osmosis-1" ? ["channel-8"] : [],
    refused: (candidate: ChannelLink) => refused.includes(candidate.channelId),
  });

  it("keeps only the canonical and manual channels of a canonical pair", () => {
    const links = [link("channel-5", "verified"), link("channel-8", "seed"), link("channel-6", "manual")];
    expect(routableLinks(links, knowledge()).map((l) => l.channelId)).toEqual([
      "channel-8",
      "channel-6",
    ]);
  });

  it("falls back to the other channels when the canonical one is ruled out", () => {
    const links = [link("channel-5", "verified"), link("channel-8", "seed")];
    expect(routableLinks(links, knowledge(["channel-8"])).map((l) => l.channelId)).toEqual([
      "channel-5",
    ]);
  });

  it("leaves pairs the registry does not name alone, minus refused channels", () => {
    const links = [link("channel-40", "verified", "noble-1"), link("channel-41", "seed", "noble-1")];
    expect(routableLinks(links, knowledge(["channel-41"])).map((l) => l.channelId)).toEqual([
      "channel-40",
    ]);
  });

  it("filters the reverse links the directory derives, too", () => {
    const directory = createChannelDirectory([
      {
        sourceChainId: "osmosis-1",
        destChainId: "injective-1",
        channelId: "channel-109",
        counterpartyChannelId: "channel-5",
        source: "verified",
      },
      {
        sourceChainId: "osmosis-1",
        destChainId: "injective-1",
        channelId: "channel-122",
        counterpartyChannelId: "channel-8",
        source: "seed",
      },
    ]);
    // Only the Osmosis side is listed; the Injective side is derived.
    expect(
      routableLinks(directory.from("injective-1"), knowledge()).map((l) => l.channelId),
    ).toEqual(["channel-8"]);
  });
});
