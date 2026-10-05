import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeBase64Utf8, type BuiltMsg, type OsmosisSwapQuote } from "@zunialab/interchain";

import { QUOTE_TTL_MS } from "../../../config/interchain";
import { clearInterchainCaches } from "../../../lib/interchain";
import { osmosisSwapAssets, parseOsmosisTokenMetadata } from "../../../lib/osmosis-assets";
import {
  buildTransferMsgFromPlan,
  planSwap,
  resetChannelChecks,
  type ManualChannel,
  type RoutePlanView,
} from "../../../lib/route-plan";
import { findCatalogEntry } from "../../../lib/chain-catalog";
import {
  buyOptions,
  sellOptions,
  type AssetOption,
  type HeldBalance,
  type SwapChain,
} from "../../../lib/swap-assets";
import { MAX_ONLY_NOTE, amountFieldText, canTypeAmount } from "../../../lib/token-amount";
import { resolveTxMemo } from "../../../lib/tx-memo";
import { noRouteReason, parseRouterState, type XcsRouteTable } from "../../../lib/xcs-routes";
import sqs from "../../../lib/__tests__/fixtures/swap/sqs-tokens-metadata.json";
import wallet from "../../../lib/__tests__/fixtures/swap/wallet.json";
import live from "../../../lib/__tests__/fixtures/swap/xcs-route-table.json";
import { buyListCopy, swapPickerItem } from "../components/SwapPair";
import { pendingRouteLabel, swapRouteLabel } from "./interchain-ui";
import {
  PRICE_EXPIRED,
  SwapTerms,
  UNREADABLE_SWAP,
  amountUnitsOf,
  boughtIdentity,
  deliveryLine,
  minimumTerms,
  ownerOf,
  pickTo,
  priceExpired,
  quoteBlockText,
  readSwapMessage,
  reviewDrift,
  scaleOf,
  swapPlanKey,
  swapPlanRequest,
  swapQuoteView,
  swapSignBlock,
  swapTermsProblems,
  type LiveSwap,
  type ReviewedSwap,
} from "./SwapScreen";

/**
 * The swap screen's own logic, on the real lists (lib/swap-assets.ts over the
 * WP-D1 fixtures) and, for what gets signed, the real planner against a fake
 * IBC world behind `fetch` (the one lib/__tests__/swap-plan.test.ts uses,
 * trimmed to the Hub and Osmosis).
 *
 * The first block is the display-only invariant: whatever the identities on
 * screen say, the request the screen builds signs exactly the bytes 0.1.2
 * signed for the same pair and amount. It fails if a signed denom, amount,
 * channel or memo changes.
 *
 * The last two blocks are the confirm screen: what it says the swap contract
 * will do, read out of the message that is signed (a contract call from funds
 * on Osmosis, and a transfer whose memo calls it), and the review it freezes
 * when it opens, which stops standing once the form would sign anything else.
 */

/* -------------------------------------------------------------------------- *
 * The lists, as the screen builds them
 * -------------------------------------------------------------------------- */

const chains: SwapChain[] = wallet.chains.map(({ chainId }) => {
  const entry = findCatalogEntry(chainId);
  if (!entry) throw new Error(`${chainId} is not in the catalog`);
  return { chainId, entry };
});
const balances: Record<string, HeldBalance> = wallet.balances;
const osmosis = osmosisSwapAssets(parseOsmosisTokenMetadata(sqs));
const routes: XcsRouteTable = {
  xcsContract: live.xcsContract,
  swapContract: live.swapContract,
  routes: parseRouterState(live.pages.flatMap((page) => page.body.models)),
  readAt: 0,
};
const sell = sellOptions(chains, balances, osmosis);

function row(options: readonly AssetOption[], key: string): AssetOption {
  const option = options.find((candidate) => candidate.key === key);
  if (!option) throw new Error(`${key} is not offered`);
  return option;
}

function buy(from: AssetOption | null): AssetOption[] {
  return buyOptions(chains, balances, { from, osmosis, routes });
}

const ATOM_ON_OSMOSIS = "ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2";
const STATOM_ON_OSMOSIS = "ibc/C140AFD542AE77BD7DCC83F13FDD8C5E5BB8C4929785E6EC2F4C636F98F17901";
const USDC_AXL_ON_OSMOSIS = "ibc/D189335C6E4A68B513C10AB227BF1C1D38C746766278BA3EEB4FB14124F1D858";
const USDC_N_ON_OSMOSIS = "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4";
const USDC_INJ_ON_OSMOSIS = "ibc/794C7D7F3B857713878A3A1927251FA6AC1EEE520424C1F6FAFE9BA26D476138";
const UNLISTED = "ibc/0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF";

/* -------------------------------------------------------------------------- *
 * A fake IBC world (from lib/__tests__/swap-plan.test.ts)
 * -------------------------------------------------------------------------- */

const XCS = "osmo1uwk8xc6q0s6t5qcpr6rht3sczu6du83xq8pwxjua0hfj5hzcnh3sqxwvxs";
const ROUTER = "osmo1fy547nr4ewfc38z73ghr6x62p7eguuupm66xwk8v8rjnjyeyxdqs6gdqx7";
const SQS = "https://sqs.osmosis.zone";
const REST: Record<string, string> = {
  "cosmoshub-4": "https://lcd-cosmoshub.keplr.app",
  "osmosis-1": "https://lcd-osmosis.keplr.app",
};

interface FakeChannel {
  readonly channelId: string;
  readonly counterpartyChainId: string;
  readonly counterpartyChannelId: string;
  readonly clientId: string;
}

const CHANNELS: Record<string, FakeChannel[]> = {
  "osmosis-1": [
    { channelId: "channel-0", counterpartyChainId: "cosmoshub-4", counterpartyChannelId: "channel-141", clientId: "07-tendermint-1" },
  ],
  "cosmoshub-4": [
    { channelId: "channel-141", counterpartyChainId: "osmosis-1", counterpartyChannelId: "channel-0", clientId: "07-tendermint-259" },
  ],
};

const OSMOSIS_TRACES: Record<string, { path: string; base_denom: string }> = {
  [ATOM_ON_OSMOSIS.slice(4)]: { path: "transfer/channel-0", base_denom: "uatom" },
};

/** Directional pairs the swaprouter holds. Every other pair is "not found". */
const ROUTES = new Set([
  `${ATOM_ON_OSMOSIS}>uosmo`,
  `uosmo>${ATOM_ON_OSMOSIS}`,
  `${ATOM_ON_OSMOSIS}>${STATOM_ON_OSMOSIS}`,
]);

function respond(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function chainAnswer(chainId: string, url: URL): Response {
  const path = decodeURIComponent(url.pathname);
  const rows = CHANNELS[chainId] ?? [];
  const connectionOf = (r: FakeChannel) => `connection-for-${r.clientId}`;
  const notFound = respond(404, { code: 5, message: `${path}: not found`, details: [] });
  let match: RegExpMatchArray | null;
  if ((match = path.match(/^\/ibc\/core\/channel\/v1\/channels\/([^/]+)\/ports\/transfer\/client_state$/))) {
    const r = rows.find((candidate) => candidate.channelId === match![1]);
    if (!r) return notFound;
    return respond(200, {
      identified_client_state: {
        client_id: r.clientId,
        client_state: { "@type": "/ibc.lightclients.tendermint.v1.ClientState", chain_id: r.counterpartyChainId },
      },
    });
  }
  if ((match = path.match(/^\/ibc\/core\/channel\/v1\/channels\/([^/]+)\/ports\/transfer$/))) {
    const r = rows.find((candidate) => candidate.channelId === match![1]);
    if (!r) return notFound;
    return respond(200, {
      channel: {
        state: "STATE_OPEN",
        ordering: "ORDER_UNORDERED",
        counterparty: { port_id: "transfer", channel_id: r.counterpartyChannelId },
        connection_hops: [connectionOf(r)],
        version: "ics20-1",
      },
    });
  }
  if (path === "/ibc/core/channel/v1/channels") {
    return respond(200, {
      channels: rows.map((r) => ({
        state: "STATE_OPEN",
        ordering: "ORDER_UNORDERED",
        counterparty: { port_id: "transfer", channel_id: r.counterpartyChannelId },
        connection_hops: [connectionOf(r)],
        version: "ics20-1",
        port_id: "transfer",
        channel_id: r.channelId,
      })),
      pagination: { next_key: null, total: String(rows.length) },
    });
  }
  if ((match = path.match(/^\/ibc\/core\/connection\/v1\/connections\/(.+)$/))) {
    const r = rows.find((candidate) => connectionOf(candidate) === match![1]);
    if (!r) return notFound;
    return respond(200, { connection: { client_id: r.clientId, state: "STATE_OPEN" } });
  }
  if ((match = path.match(/^\/ibc\/core\/client\/v1\/client_states\/(.+)$/))) {
    const r = rows.find((candidate) => candidate.clientId === match![1]);
    if (!r) return notFound;
    return respond(200, {
      client_state: { "@type": "/ibc.lightclients.tendermint.v1.ClientState", chain_id: r.counterpartyChainId },
    });
  }
  if ((match = path.match(/^\/ibc\/core\/client\/v1\/client_status\/(.+)$/))) {
    const r = rows.find((candidate) => candidate.clientId === match![1]);
    return r ? respond(200, { status: "Active" }) : notFound;
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
      const encoded = decodeURIComponent(url.pathname.split("/smart/")[1] ?? "");
      const standard = encoded.replace(/-/g, "+").replace(/_/g, "/");
      const query = JSON.parse(Buffer.from(standard, "base64").toString("utf8")) as {
        get_route?: { input_denom: string; output_denom: string };
      };
      const pair = query.get_route;
      if (pair && ROUTES.has(`${pair.input_denom}>${pair.output_denom}`)) {
        return respond(200, { data: { pool_route: [{ pool_id: "1", token_out_denom: pair.output_denom }] } });
      }
      return respond(500, {
        code: 2,
        message: "Generic error: Querier contract error: Vec<SwapAmountInRoute> not found: query wasm contract failed",
        details: [],
      });
    }
  }
  return respond(501, { code: 12, message: "Not Implemented", details: [] });
}

function sqsAnswer(url: URL): Response {
  if (url.pathname !== "/router/custom-direct-quote") return respond(501, { code: 12, message: "Not Implemented" });
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

function install(): void {
  vi.stubGlobal("fetch", async (input: string): Promise<Response> => {
    const url = new URL(String(input));
    if (url.origin === SQS) return sqsAnswer(url);
    const chainId = Object.entries(REST).find(([, rest]) => rest === url.origin)?.[0];
    if (!chainId) throw new Error(`unexpected request to ${url.href}`);
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
}

const VENUE = { chainId: "osmosis-1", contractAddress: XCS, label: "Osmosis" } as const;
const HUB_ADDRESS = "cosmos1sender0000000000000000000000000000000";
const OSMO_ADDRESS = "osmo1sender00000000000000000000000000000000";
const RECOVERY = "osmo1recovery000000000000000000000000000000";
const resolveAddresses = async () => ({});

/* -------------------------------------------------------------------------- *
 * What 0.1.2 signed (the golden bytes of lib/__tests__/swap-plan.test.ts)
 * -------------------------------------------------------------------------- */

const ATOM_TO_OSMO_MEMO =
  '{"wasm":{"contract":"osmo1uwk8xc6q0s6t5qcpr6rht3sczu6du83xq8pwxjua0hfj5hzcnh3sqxwvxs",' +
  '"msg":{"osmosis_swap":{"output_denom":"uosmo",' +
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

/** The request a screen built before identity: the fields the golden bytes were planned from. */
function signedFields(input: ReturnType<typeof swapPlanRequest>) {
  const { expectedVenueInputDenom: _in, expectedVenueOutputDenom: _out, ...signed } = input;
  return signed;
}

/** What the screen does with the text in the From field. */
function typed(from: AssetOption, text: string): bigint {
  expect(canTypeAmount(from.identity)).toBe(true);
  const units = amountUnitsOf(from, text);
  if (units === null) throw new Error(`${text} does not convert`);
  return units;
}

function request(from: AssetOption, to: AssetOption, units: bigint, manual: readonly ManualChannel[] = []) {
  return swapPlanRequest({
    from,
    to,
    amountUnits: units,
    sender: from.chainId === "osmosis-1" ? OSMO_ADDRESS : HUB_ADDRESS,
    recipient: to.chainId === "osmosis-1" ? OSMO_ADDRESS : HUB_ADDRESS,
    recoveryAddress: RECOVERY,
    slippagePercent: 1,
    venue: VENUE,
    manualChannels: manual,
    resolveAddresses,
  });
}

async function signedBytes(input: ReturnType<typeof swapPlanRequest>): Promise<{ view: RoutePlanView; msg: string }> {
  const result = await planSwap(input);
  expect(result.error).toBeNull();
  const view = result.best!;
  expect(view.blockedReason).toBeNull();
  const msg = JSON.stringify(
    buildTransferMsgFromPlan({ view, sender: input.sender, amountBaseUnits: input.amountBaseUnits }),
  );
  return { view, msg };
}

describe("what the screen asks to sign", () => {
  beforeEach(() => {
    install();
    clearInterchainCaches();
    resetChannelChecks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-05T12:00:00Z"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    clearInterchainCaches();
    resetChannelChecks();
  });

  it("copies the signed fields verbatim from the rows; identity only adds the venue check", () => {
    const from = row(sell, "cosmoshub-4:uatom");
    const to = row(buy(from), "osmosis-1:uosmo");
    const input = request(from, to, typed(from, "1"));
    expect(signedFields(input)).toEqual({
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
      manualChannels: [],
      resolveAddresses,
    });
    expect(input.expectedVenueInputDenom).toBe(ATOM_ON_OSMOSIS);
    expect(input.expectedVenueOutputDenom).toBe("uosmo");
  });

  it("signs the 0.1.2 bytes for ATOM on the Hub into OSMO delivered on Osmosis", async () => {
    const from = row(sell, "cosmoshub-4:uatom");
    const to = row(buy(from), "osmosis-1:uosmo");
    expect(to.disabledReason).toBeNull();
    const input = request(from, to, typed(from, "1"));
    const signed = await signedBytes(input);
    expect(signed.view.plan.memo).toBe(ATOM_TO_OSMO_MEMO);
    expect(signed.msg).toBe(ATOM_TO_OSMO_MSG);

    // The same request without the identity check signs the same bytes.
    resetChannelChecks();
    expect((await signedBytes(signedFields(input) as typeof input)).msg).toBe(ATOM_TO_OSMO_MSG);
  });

  it("signs every pair's row fields verbatim, never an identity's denom", () => {
    let pairs = 0;
    for (const from of sell) {
      for (const to of buy(from)) {
        const input = request(from, to, 1234567n);
        expect([input.sourceChainId, input.inputDenom]).toEqual([from.chainId, from.denom]);
        expect([input.destChainId, input.destDenom]).toEqual([to.chainId, to.denom]);
        expect(input.amountBaseUnits).toBe("1234567");
        pairs += 1;
      }
    }
    expect(pairs).toBeGreaterThan(2000);
  });

  it("puts a voucher To's exact Osmosis denom in the memo", async () => {
    const from = row(sell, "cosmoshub-4:uatom");
    const to = row(buy(from), `osmosis-1:${STATOM_ON_OSMOSIS}`);
    expect(to.disabledReason).toBeNull();
    expect(to.identity.originDenom).toBe("stuatom");
    const { view, msg } = await signedBytes(request(from, to, typed(from, "1")));
    const memo = ATOM_TO_OSMO_MEMO.replace('"output_denom":"uosmo"', `"output_denom":"${STATOM_ON_OSMOSIS}"`);
    expect(view.plan.memo).toBe(memo);
    expect(msg).toBe(ATOM_TO_OSMO_MSG.replace(JSON.stringify(ATOM_TO_OSMO_MEMO), JSON.stringify(memo)));
  });

  it("signs the 0.1.2 contract call for OSMO into ATOM delivered on the Hub", async () => {
    const from = row(sell, "osmosis-1:uosmo");
    const to = row(buy(from), "cosmoshub-4:uatom");
    expect(to.disabledReason).toBeNull();
    const signed = await signedBytes(request(from, to, typed(from, "63")));
    expect(signed.msg).toBe(OSMO_TO_ATOM_MSG);
  });

  it("keeps a channel the user pinned in the signed transfer", async () => {
    const from = row(sell, "cosmoshub-4:uatom");
    const to = row(buy(from), "osmosis-1:uosmo");
    const pinned = [{ fromChainId: "cosmoshub-4", toChainId: "osmosis-1", channelId: "channel-141" }];
    const input = request(from, to, typed(from, "1"), pinned);
    expect(input.manualChannels).toEqual(pinned);
    expect((await signedBytes(input)).msg).toBe(ATOM_TO_OSMO_MSG);
  });

  it("converts a Max-only amount exactly, whatever its size", () => {
    const unknown = row(sell, `osmosis-1:${UNLISTED}`);
    expect(canTypeAmount(unknown.identity)).toBe(false);
    expect(unknown.decimals).toBe(0);
    expect(MAX_ONLY_NOTE).toMatch(/only Max/);
    for (const units of [12340000n, 10n ** 29n + 7n]) {
      expect(amountUnitsOf(unknown, amountFieldText(units, unknown.identity))).toBe(units);
    }
    // INJ: 18 decimals, far above 2^53 base units.
    const inj = row(sell, "injective-1:inj");
    const units = 1_499_999_999_999_999_999n;
    expect(amountUnitsOf(inj, amountFieldText(units, inj.identity))).toBe(units);
    expect(amountUnitsOf(inj, "")).toBeNull();
    expect(amountUnitsOf(undefined, "1")).toBeNull();
  });

  it("converts typed text with the row's exponent, the one its balance is shown with", () => {
    // An unnamed token whose chain metadata gives 6 decimals: the row (and its
    // identity) carry the reader's exponent, which identityOf alone does not know.
    const metadata = "ibc/FEDCBA9876543210FEDCBA9876543210FEDCBA9876543210FEDCBA9876543210";
    const rows = sellOptions(
      chains,
      { ...balances, "osmosis-1": { tokens: [{ denom: metadata, amount: "5000000", decimals: 6, decimalsKnown: true }] } },
      osmosis,
    );
    const held = row(rows, `osmosis-1:${metadata}`);
    expect(held.decimals).toBe(6);
    expect(canTypeAmount(held.identity)).toBe(true);
    expect(amountUnitsOf(held, "1.5")).toBe(1_500_000n);
    expect(amountUnitsOf(held, "1.1234567")).toBeNull();
  });

  it("reads typed text against the exponent it was typed for", () => {
    const usdcN = row(sell, `osmosis-1:${USDC_N_ON_OSMOSIS}`);
    const vetoed: AssetOption = {
      ...usdcN,
      decimals: 0,
      decimalsKnown: false,
      identity: { ...usdcN.identity, decimals: 0, decimalsKnown: false },
    };
    expect(scaleOf(usdcN)).not.toBe(scaleOf(vetoed));
  });
});

/* -------------------------------------------------------------------------- *
 * Labels for Activity, the notification and the resume banner
 * -------------------------------------------------------------------------- */

describe("route labels", () => {
  beforeEach(() => {
    install();
    clearInterchainCaches();
    resetChannelChecks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-05T12:00:00Z"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    clearInterchainCaches();
    resetChannelChecks();
  });

  it("names a swap delivered off Osmosis by its ticker, as the stored label does, not by the venue denom", async () => {
    const from = row(sell, "osmosis-1:uosmo");
    const to = row(buy(from), "cosmoshub-4:uatom");
    const { view } = await signedBytes(request(from, to, typed(from, "63")));
    // What the planner stores: the venue's denom, which names nothing on the Hub.
    expect(view.plan.destChainId).toBe("cosmoshub-4");
    expect(view.plan.outputDenom).toBe(ATOM_ON_OSMOSIS);
    const stored = swapRouteLabel("63000000", from.identity, to.identity);
    expect(stored).toBe("63 OSMO (Osmosis) → ATOM (Cosmos Hub)");
    const banner = pendingRouteLabel({ kind: "swap", plan: view.plan, amountBaseUnits: "63000000", label: stored });
    expect(banner).toBe(stored);
    expect(banner).not.toMatch(/IBC·|ibc\//);
  });

  it("names USDC.axl delivered on Axelar, and a swap delivered on Osmosis", () => {
    const plan = (destChainId: string, outputDenom: string, sourceChainId = "osmosis-1", inputDenom = "uosmo") =>
      ({ sourceChainId, inputDenom, destChainId, outputDenom, hops: [], memo: "", warnings: [] }) as never;
    expect(
      pendingRouteLabel({ kind: "swap", plan: plan("axelar-dojo-1", USDC_AXL_ON_OSMOSIS), amountBaseUnits: "100000", label: "x" }),
    ).toBe("0.1 OSMO (Osmosis) → USDC.axl (Axelar)");
    expect(
      pendingRouteLabel({
        kind: "swap",
        plan: plan("osmosis-1", "uosmo", "cosmoshub-4", "uatom"),
        amountBaseUnits: "1000000",
        label: "x",
      }),
    ).toBe("1 ATOM (Cosmos Hub) → OSMO (Osmosis)");
    // A 0.1.2 record that called Noble USDC "USDC.axl" reads right.
    expect(
      pendingRouteLabel({
        kind: "swap",
        plan: plan("cosmoshub-4", ATOM_ON_OSMOSIS, "osmosis-1", USDC_N_ON_OSMOSIS),
        amountBaseUnits: "12340000",
        label: "12.34 USDC.axl → ATOM",
      }),
    ).toBe("12.34 USDC.n (Osmosis) → ATOM (Cosmos Hub)");
    // Nothing names the output: the stored words, never a hash ticker.
    expect(
      pendingRouteLabel({ kind: "swap", plan: plan("cosmoshub-4", UNLISTED), amountBaseUnits: "1", label: "stored words" }),
    ).toBe("stored words");
  });

  it("names a transfer by its token and destination", () => {
    const plan = { sourceChainId: "osmosis-1", inputDenom: USDC_N_ON_OSMOSIS, destChainId: "noble-1", outputDenom: "uusdc", hops: [], memo: "", warnings: [] } as never;
    expect(pendingRouteLabel({ kind: "transfer", plan, amountBaseUnits: "12340000", label: "x" })).toBe(
      "12.34 USDC.n → Noble",
    );
  });
});

/* -------------------------------------------------------------------------- *
 * The quote and the confirm screen
 * -------------------------------------------------------------------------- */

function quote(overrides: Partial<OsmosisSwapQuote> = {}): OsmosisSwapQuote {
  return {
    inputDenom: "uosmo",
    inputAmount: "10000000",
    outputDenom: USDC_AXL_ON_OSMOSIS,
    outputAmount: "35921234",
    priceImpact: 0.02,
    poolFee: 0.2,
    minReceived: "35561021",
    slippagePercent: 1,
    route: [{ poolId: "678", tokenOutDenom: USDC_AXL_ON_OSMOSIS }],
    source: "sqs",
    splits: [],
    spotPrice: "3.6",
    effectiveFeeFraction: "0.002",
    warnings: [],
    fetchedAt: 0,
    ...overrides,
  } as OsmosisSwapQuote;
}

describe("the quote as shown", () => {
  const osmo = row(sell, "osmosis-1:uosmo");
  const usdcAxl = row(buy(osmo), "axelar-dojo-1:uusdc");

  it("gives the panel bare amounts, so its ticker reads once", () => {
    const view = swapQuoteView(quote(), osmo, usdcAxl);
    expect(view.inputAmount).toBe("10");
    expect(view.inputSymbol).toBe("OSMO");
    expect(view.outputAmount).toBe("35.921234");
    expect(view.outputSymbol).toBe("USDC.axl");
    expect(view.minReceived).toBe("35.561021");
    // SwapQuotePanel prints `${minReceived} ${outputSymbol}`.
    expect(`${view.minReceived} ${view.outputSymbol}`).toBe("35.561021 USDC.axl");
    expect(view.rate).toBe("1 OSMO ≈ 3.5921 USDC.axl");
    expect(view.route).toEqual([{ poolId: "678", tokenOutSymbol: "USDC.axl" }]);
  });

  it("says where the token arrives, and a floor only when the message sets one", () => {
    // `min_output_amount` is a number the contract is held to: said as "at least".
    const exact = minimumTerms(
      { slippage: { kind: "min_output_amount", minOutputAmount: "35561021" }, outputDenom: USDC_AXL_ON_OSMOSIS },
      usdcAxl.identity,
      quote(),
    );
    expect(exact).toEqual({ rule: "35.561021 USDC.axl", estimate: null, exact: "35.561021 USDC.axl" });
    expect(deliveryLine(usdcAxl, exact.exact)).toBe("Delivered on Axelar · at least 35.561021 USDC.axl");
    // A TWAP tolerance is a rule: the quote's floor is an estimate, never "at least".
    const twap = minimumTerms(
      {
        slippage: { kind: "twap", slippagePercentage: "1", windowSeconds: 10 },
        outputDenom: USDC_AXL_ON_OSMOSIS,
      },
      usdcAxl.identity,
      quote(),
    );
    // Worked out from the message's own 1% off the quoted 35.921234, not
    // taken from the quote's floor.
    expect(twap).toEqual({
      rule: "The 10-second average price, less 1%",
      estimate: "About 35.562021 USDC.axl at the quoted price",
      exact: null,
    });
    expect(deliveryLine(usdcAxl, twap.exact)).toBe("Delivered on Axelar");
    // A quote for another output estimates nothing.
    expect(
      minimumTerms(
        { slippage: { kind: "twap", slippagePercentage: "1", windowSeconds: 10 }, outputDenom: "uosmo" },
        usdcAxl.identity,
        quote(),
      ).estimate,
    ).toBeNull();
  });

  it("reads unknown decimals in base units, with no rate", () => {
    const unknown = row(sell, `osmosis-1:${UNLISTED}`);
    const view = swapQuoteView(quote({ inputDenom: UNLISTED }), unknown, usdcAxl);
    expect(view.inputAmount).toBe("10000000 base units");
    expect(view.inputSymbol).toBe("IBC·0123");
    expect(view.rate).toBeNull();
  });
});

/* -------------------------------------------------------------------------- *
 * Picking and refusing
 * -------------------------------------------------------------------------- */

describe("the To side", () => {
  const osmo = row(sell, "osmosis-1:uosmo");
  const fromOsmo = buy(osmo);

  it("defaults to the first row that can be used, and keeps a refused pick with its reason", () => {
    const first = pickTo(fromOsmo, null);
    expect(first?.disabledReason).toBeNull();
    const refused = row(fromOsmo, "injective-1:erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a");
    expect(pickTo(fromOsmo, refused.key)).toBe(refused);
    expect(refused.disabledReason).toBe(noRouteReason("OSMO", "USDC.inj"));
    const saf = row(sell, "safrochain-1:usaf");
    expect(pickTo(buy(saf), null)).toBeUndefined();
  });

  it("draws the two USDC.inj rows with their location, their token logo and the plain reason", () => {
    const rows = [
      row(fromOsmo, "injective-1:erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a"),
      row(fromOsmo, `osmosis-1:${USDC_INJ_ON_OSMOSIS}`),
    ];
    const items = rows.map((option) => swapPickerItem(option, false));
    expect(items.map((item) => item.sublabel)).toEqual(["Native on Injective", "Injective USDC · on Osmosis"]);
    for (const item of items) {
      expect(item.disabled).toBe(true);
      expect(item.searchOnly).toBe(true);
      expect(item.disabledReason).toBe("Zunia's Osmosis swap contract has no route from OSMO to USDC.inj yet.");
      expect(item.srNote).toMatch(/^Verified: /);
      const icon = item.icon as { props: { locationBadge: string; identity: { logoUrl: string | null } } };
      expect(icon.props.locationBadge).toBe("always");
      expect(icon.props.identity.logoUrl).toBeTruthy();
      for (const chainId of ["osmosis-1", "injective-1"]) {
        expect(icon.props.identity.logoUrl).not.toBe(findCatalogEntry(chainId)?.iconUrl);
      }
    }
  });

  it("words what the list leaves out, with no 'more' when it lists nothing", () => {
    const listed = buyListCopy(fromOsmo, "OSMO");
    expect(listed.searchOnlyNote(351)).toBe("351 more cannot be bought with OSMO. Search to see why.");
    const saf = row(sell, "safrochain-1:usaf");
    const none = buyListCopy(buy(saf), "SAF");
    expect(none.empty).toBe("Nothing can be bought with SAF here. Search to see each token and why.");
    expect(none.searchOnlyNote(366)).toBe("366 tokens appear when you search.");
    expect(none.searchOnlyNote(1)).toBe("1 token appears when you search.");
    expect(buyListCopy([], undefined).empty).toBe("No token to receive yet.");
  });

  it("words each known quote block with the tickers on screen", () => {
    const usdcInj = row(fromOsmo, "injective-1:erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a");
    expect(quoteBlockText("no-contract-route", "planner words", osmo, usdcInj, null)).toBe(
      "Zunia's Osmosis swap contract has no route from OSMO to USDC.inj yet. The swap stays unsigned.",
    );
    expect(quoteBlockText(null, "planner words", osmo, usdcInj, null)).toBe("planner words");
    // The plan does not say which side: both tickers are named.
    expect(quoteBlockText("venue-denom-mismatch", "x", osmo, usdcInj, null)).toBe(
      "Zunia would trade a different variant than the OSMO and USDC.inj you picked, so the swap stays unsigned.",
    );
    // The route sells OSMO as expected, so the bought side is the other variant.
    const sellsOsmo = { candidate: { venueInputDenom: "uosmo" } } as unknown as RoutePlanView;
    expect(quoteBlockText("venue-denom-mismatch", "x", osmo, usdcInj, sellsOsmo)).toBe(
      "Zunia would trade a different USDC variant than the USDC.inj you picked, so the swap stays unsigned.",
    );
  });
});

/* -------------------------------------------------------------------------- *
 * The confirm screen: what the message that is signed will do
 * -------------------------------------------------------------------------- */

const decodeEntities = (text: string) =>
  text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");

/** The pieces of text assistive tech reads: what is drawn only for the eye (aria-hidden) left out. */
function spokenPieces(html: string): string[] {
  return html
    .replace(/<span aria-hidden="true"[^>]*>(?:(?!<\/span>).)*<\/span>/g, "")
    .split(/<[^>]+>/)
    .map((piece) => decodeEntities(piece).trim())
    .filter(Boolean);
}

/** The text on screen: what only assistive tech hears (sr-only) left out. */
function shownText(html: string): string {
  return decodeEntities(html.replace(/<span class="sr-only[^"]*">[^<]*<\/span>/g, "").replace(/<[^>]+>/g, ""));
}

/** Each row of the terms panel: its label, and the pieces it says. */
function termRows(html: string): Record<string, string[]> {
  const rows: Record<string, string[]> = {};
  for (const chunk of html.split('<div class="flex min-w-0 items-baseline justify-between').slice(1)) {
    const label = /<span class="shrink-0 text-fg-muted">([^<]*)<\/span>/.exec(chunk)?.[1] ?? "?";
    const value = chunk.slice(chunk.indexOf("</span>") + "</span>".length).split("</div></div>")[0] ?? "";
    rows[label] = spokenPieces(value);
  }
  return rows;
}

const OTHER_HUB = "cosmos1someoneelse00000000000000000000000000";
const OTHER_OSMO = "osmo1someoneelse000000000000000000000000000";
const NOBLE_ADDRESS = "noble1sender00000000000000000000000000000";

/** The contract call's ExecuteMsg, decoded, for building a message that says something else. */
function executeBody(message: BuiltMsg): Record<string, Record<string, unknown>> {
  const raw = (message.value as { msg: string }).msg;
  return JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as Record<string, Record<string, unknown>>;
}

/** The same contract call with its `osmosis_swap` fields changed, encoded the way the planner encodes it. */
function withSwap(message: BuiltMsg, change: Record<string, unknown>): BuiltMsg {
  const body = executeBody(message);
  const swap = { ...body.osmosis_swap, ...change };
  return { ...message, value: { ...message.value, msg: encodeBase64Utf8(JSON.stringify({ osmosis_swap: swap })) } };
}

describe("the confirm screen's terms, read from the message that is signed", () => {
  beforeEach(() => {
    install();
    clearInterchainCaches();
    resetChannelChecks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-05T12:00:00Z"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    clearInterchainCaches();
    resetChannelChecks();
  });

  /**
   * The review the screen captures when its confirm screen opens, for the
   * real plan: the rows, the typed amount, the plan, a price for it, and the
   * addresses the plan was asked for.
   */
  async function reviewOf(fromKey: string, toKey: string, text: string, price: OsmosisSwapQuote) {
    const from = row(sell, fromKey);
    const to = row(buy(from), toKey);
    const amountUnits = typed(from, text);
    const input = request(from, to, amountUnits);
    const { view, msg } = await signedBytes(input);
    const review: ReviewedSwap = {
      id: 1,
      from,
      to,
      amountUnits,
      plan: view,
      planKey: swapPlanKey({ from, to, amountUnits, slippage: 1, manual: [], contract: XCS, retryToken: 0 }),
      requote: {
        venueChainId: "osmosis-1",
        venueContract: XCS,
        venueInputDenom: price.inputDenom,
        venueOutputDenom: price.outputDenom,
        amountBaseUnits: amountUnits.toString(),
        slippagePercent: 1,
      },
      price: { quote: price, error: null, code: null, at: Date.now() },
      recipient: input.recipient,
      recoveryAddress: RECOVERY,
      contract: XCS,
      contractLabel: "CrossChainSwaps v1.2",
      ownAddresses: {},
    };
    return { review, message: JSON.parse(msg) as BuiltMsg, msg };
  }

  /** What the confirm screen reads out of `message` for `review`, and draws. */
  function confirmTerms(message: BuiltMsg, review: ReviewedSwap) {
    const facts = readSwapMessage(message);
    const problems = swapTermsProblems(facts, review, { chainId: review.from.chainId, msgCount: 1 });
    const html = renderToStaticMarkup(
      createElement(SwapTerms, { facts, review, problems, onCopy: () => undefined }),
    );
    return { facts, problems, html, rows: termRows(html) };
  }

  const osmoToAtom = () =>
    reviewOf(
      "osmosis-1:uosmo",
      "cosmoshub-4:uatom",
      "63",
      quote({
        inputAmount: "63000000",
        outputDenom: ATOM_ON_OSMOSIS,
        outputAmount: "15750000",
        minReceived: "15592500",
        route: [{ poolId: "1", tokenOutDenom: ATOM_ON_OSMOSIS }],
      }),
    );

  it("a swap from funds already on Osmosis: one contract call, each fact read out of it", async () => {
    const { review, message, msg } = await osmoToAtom();
    // What is read is what is signed: the 0.1.2-planned contract call, byte for byte.
    expect(msg).toBe(OSMO_TO_ATOM_MSG);
    const { facts, problems, html, rows } = confirmTerms(message, review);
    expect(facts).toEqual({
      via: "contract-call",
      sold: { denom: "uosmo", amount: "63000000" },
      contract: XCS,
      transferReceiver: null,
      forwardsIn: [],
      swap: {
        contract: XCS,
        outputDenom: ATOM_ON_OSMOSIS,
        receiver: HUB_ADDRESS,
        slippage: { kind: "twap", slippagePercentage: "1", windowSeconds: 10 },
        onFailedDelivery: { kind: "local_recovery_addr", address: RECOVERY },
        hasNextMemo: false,
      },
      forwardsOut: null,
      warnings: [],
    });
    expect(problems).toEqual([]);

    // In plain words, before signing, with nothing about a packet arriving.
    const text = shownText(html);
    expect(text).toContain("What the contract call does");
    expect(text).toContain(
      "One call to the swap contract on Osmosis, paid from your balance there. Nothing is transferred before the swap.",
    );
    expect(text).not.toMatch(/On arrival|IBC transfer|memo/);
    expect(rows).toEqual({
      Sells: ["63 OSMO", "Held on Osmosis"],
      Buys: ["ATOM", "Cosmos Hub ATOM · delivered on Cosmos Hub", "ibc/2739…1E5EB2 on Osmosis"],
      "Pays out to": [HUB_ADDRESS, "Your address on Cosmos Hub"],
      "Minimum received": ["The 10-second average price, less 1%", "About 15.5925 ATOM at the quoted price"],
      "If delivery fails": ["Kept for", RECOVERY, "Your address on Osmosis, which can claim the output back"],
      Contract: [XCS, "The swap contract Zunia verified on Osmosis (CrossChainSwaps v1.2)"],
    });
    // The tx-body memo the kernel previews and signs for this call names the
    // pair, not "Contract call" (lib/tx-memo.ts).
    expect(resolveTxMemo("", [message], "osmosis-1")).toBe("Swap OSMO to ATOM · by Zunia-wallet");
    // The exact output denom, whole, to copy; short on screen.
    expect(html).toContain(`title="${ATOM_ON_OSMOSIS}"`);
    expect(html).toContain(`aria-label="Copy the exact denom on Osmosis: ${ATOM_ON_OSMOSIS}"`);
    // Addresses are short on screen and whole in their tooltip.
    expect(text).toContain("cosmos1sen…00000000");
    expect(html).toContain(`title="${HUB_ADDRESS}"`);
    expect(html).toContain(`title="${RECOVERY}"`);
  });

  it("a swap from another chain: an IBC transfer whose memo calls the contract when it arrives", async () => {
    const { review, message, msg } = await reviewOf(
      "cosmoshub-4:uatom",
      "osmosis-1:uosmo",
      "1",
      quote({
        inputDenom: ATOM_ON_OSMOSIS,
        inputAmount: "1000000",
        outputDenom: "uosmo",
        outputAmount: "4000000",
        minReceived: "3960000",
        route: [{ poolId: "1", tokenOutDenom: "uosmo" }],
      }),
    );
    expect(msg).toBe(ATOM_TO_OSMO_MSG);
    const { facts, problems, html, rows } = confirmTerms(message, review);
    expect(facts).toMatchObject({
      via: "transfer",
      sold: { denom: "uatom", amount: "1000000" },
      contract: XCS,
      transferReceiver: XCS,
      forwardsIn: [],
      forwardsOut: null,
      swap: { outputDenom: "uosmo", receiver: OSMO_ADDRESS },
    });
    expect(problems).toEqual([]);
    const text = shownText(html);
    expect(text).toContain("What the memo will do");
    expect(text).toContain("An IBC transfer to Osmosis. When it arrives, its memo calls the swap contract.");
    expect(rows).toEqual({
      Sells: ["1 ATOM", "Held on Cosmos Hub"],
      Buys: ["OSMO", "Osmosis OSMO · delivered on Osmosis", "uosmo on Osmosis"],
      "Pays out to": [OSMO_ADDRESS, "Your address on Osmosis"],
      "Minimum received": ["The 10-second average price, less 1%", "About 3.96 OSMO at the quoted price"],
      "If delivery fails": ["Kept for", RECOVERY, "Your address on Osmosis, which can claim the output back"],
      Contract: [XCS, "The swap contract Zunia verified on Osmosis (CrossChainSwaps v1.2)"],
    });
  });

  it("refuses an address that is not this wallet's, wherever the message names it", async () => {
    const { review, message } = await osmoToAtom();
    // Pays someone else.
    const payee = confirmTerms(message, { ...review, recipient: OTHER_HUB });
    expect(payee.problems).toEqual([
      "The swap would pay cosmos1sen…00000000, which is not your address on Cosmos Hub.",
    ]);
    expect(payee.rows["Pays out to"]).toEqual([HUB_ADDRESS, "Not one of your addresses"]);
    expect(payee.html).toContain('role="alert"');
    // Keeps failed output for someone else.
    const recovery = confirmTerms(message, { ...review, recoveryAddress: OTHER_OSMO });
    expect(recovery.problems).toEqual([
      "The recovery address osmo1recov…00000000 is not your address on Osmosis.",
    ]);
    expect(recovery.rows["If delivery fails"]).toEqual(["Kept for", RECOVERY, "Not one of your addresses"]);
    // Keeps it for nobody.
    const nobody = confirmTerms(withSwap(message, { on_failed_delivery: "do_nothing" }), review);
    expect(nobody.problems).toEqual([
      "The swap sets no recovery address, so output stranded by a failed delivery could never be claimed back.",
    ]);
    expect(nobody.rows["If delivery fails"]).toEqual(["No recovery address", "The output could never be claimed back"]);
    // The engine's own warning is shown as well.
    expect(nobody.facts?.warnings.join(" ")).toMatch(/do_nothing/);
    // Each refuses the signature, in the panel's words.
    for (const { problems } of [payee, recovery, nobody]) {
      expect(
        swapSignBlock({
          problem: problems[0] ?? null,
          drift: null,
          price: review.price,
          priceError: null,
          refreshing: false,
          feeShort: false,
          now: Date.now(),
        }),
      ).toEqual({ label: "Cannot sign", reason: problems[0] });
    }
  });

  it("refuses a message that sells, buys or calls anything but what was reviewed", async () => {
    const { review, message } = await osmoToAtom();
    expect(confirmTerms(message, { ...review, amountUnits: 62_000_000n }).problems).toEqual([
      "The message spends 63 OSMO, not the 62 OSMO you reviewed.",
    ]);
    expect(confirmTerms(message, { ...review, from: row(sell, `osmosis-1:${USDC_N_ON_OSMOSIS}`) }).problems).toEqual([
      "The message spends uosmo, not the USDC.n on Osmosis you reviewed.",
    ]);
    const unverified = confirmTerms(message, { ...review, contract: ROUTER });
    expect(unverified.problems).toEqual([
      "The message calls osmo1uwk8x…3sqxwvxs, not the swap contract Zunia verified on Osmosis.",
    ]);
    expect(unverified.rows.Contract).toEqual([XCS, "Not the swap contract Zunia verified"]);
    // The memo buys another token than the To: named for what it is, and refused.
    const other = confirmTerms(withSwap(message, { output_denom: STATOM_ON_OSMOSIS }), review);
    expect(other.problems).toEqual(["The contract would buy stATOM, not the ATOM you picked."]);
    expect(other.rows.Buys).toEqual(["stATOM", "Stride stATOM · on Osmosis", "ibc/C140…F17901 on Osmosis"]);
  });

  it("describes nothing it cannot read whole, and refuses to sign it", async () => {
    const { review, message } = await osmoToAtom();
    const raw = (message.value as { msg: string }).msg;
    const body = Buffer.from(raw, "base64").toString("utf8");
    const unreadable: BuiltMsg[] = [
      // Base64 a stricter decoder could read differently: unpadded, url-safe.
      { ...message, value: { ...message.value, msg: raw.replace(/=+$/, "") } },
      { ...message, value: { ...message.value, msg: Buffer.from(`${body.slice(0, -1)} }`).toString("base64") } },
      // A key twice: parsers disagree on which one counts.
      {
        ...message,
        value: {
          ...message.value,
          msg: encodeBase64Utf8(body.replace('"receiver":', `"receiver":"${OTHER_HUB}","receiver":`)),
        },
      },
      // Two coins: the contract takes one.
      { ...message, value: { ...message.value, funds: [{ denom: "uosmo", amount: "1" }, { denom: "uion", amount: "1" }] } },
      // A field the panel would not show, which could pick the pools itself.
      withSwap(message, { route: [{ pool_id: "1", token_out_denom: ATOM_ON_OSMOSIS }] }),
      withSwap(message, {
        slippage: { twap: { slippage_percentage: "1", window_seconds: 10, fallback: "spot" } },
      }),
      // Another call on the contract, and a message of another kind.
      { ...message, value: { ...message.value, msg: encodeBase64Utf8('{"recover":{}}') } },
      { typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: { amount: [{ denom: "uosmo", amount: "1" }] } },
    ];
    for (const tampered of unreadable) {
      const { facts, problems, html, rows } = confirmTerms(tampered, review);
      expect(facts).toBeNull();
      expect(problems).toEqual([UNREADABLE_SWAP]);
      expect(rows).toEqual({});
      expect(shownText(html)).toContain(UNREADABLE_SWAP);
    }
    // A transfer whose memo is not exactly what serializing it gives back.
    const transfer = JSON.parse(ATOM_TO_OSMO_MSG) as BuiltMsg;
    const spaced = { ...transfer, value: { ...transfer.value, memo: `${ATOM_TO_OSMO_MEMO} ` } };
    expect(readSwapMessage(spaced)).toBeNull();
    expect(readSwapMessage(transfer)).not.toBeNull();
    // A message that is more than the one swap.
    expect(swapTermsProblems(readSwapMessage(message), review, { chainId: "osmosis-1", msgCount: 2 })).toEqual([
      UNREADABLE_SWAP,
    ]);
  });

  it("refuses a transfer the contract would not receive: the swap would never run", async () => {
    const { review, message } = await reviewOf(
      "cosmoshub-4:uatom",
      "osmosis-1:uosmo",
      "1",
      quote({ inputDenom: ATOM_ON_OSMOSIS, inputAmount: "1000000", outputDenom: "uosmo", outputAmount: "4000000" }),
    );
    const elsewhere = { ...message, value: { ...message.value, receiver: OSMO_ADDRESS } };
    const { facts, problems } = confirmTerms(elsewhere, review);
    expect(facts?.transferReceiver).toBe(OSMO_ADDRESS);
    expect(problems).toEqual([
      "The transfer is not addressed to the swap contract, so the swap would not run and the tokens would land somewhere else.",
    ]);
  });

  it("follows forwards before and after the swap, and every address on the way is this wallet's", async () => {
    const { review, message } = await osmoToAtom();
    // After: the contract pays this wallet on Noble, and `next_memo` forwards it to the Hub.
    const after = withSwap(message, {
      receiver: NOBLE_ADDRESS,
      next_memo: { forward: { receiver: HUB_ADDRESS, port: "transfer", channel: "channel-4" } },
    });
    const own = { ...review, ownAddresses: { "noble-1": NOBLE_ADDRESS } };
    const forwarded = confirmTerms(after, own);
    expect(forwarded.problems).toEqual([]);
    expect(forwarded.facts?.forwardsOut?.finalReceiver).toBe(HUB_ADDRESS);
    expect(forwarded.rows["Pays out to"]).toEqual([NOBLE_ADDRESS, "Your address on Noble"]);
    expect(forwarded.rows.Then).toEqual(["Forwarded over channel-4 to", HUB_ADDRESS, "Your address on Cosmos Hub"]);
    expect(ownerOf(NOBLE_ADDRESS, own)).toBe("noble-1");
    expect(ownerOf(OTHER_HUB, own)).toBeNull();
    // The same, through an address this wallet does not hold.
    expect(confirmTerms(after, review).problems).toEqual([
      "On the way, the swap would pay noble1send…00000000, which is not one of this wallet's addresses.",
    ]);
    // A forward that does not end at this wallet.
    const away = withSwap(message, {
      receiver: NOBLE_ADDRESS,
      next_memo: { forward: { receiver: OTHER_HUB, port: "transfer", channel: "channel-4" } },
    });
    expect(confirmTerms(away, own).problems).toEqual([
      "The swap would pay cosmos1som…00000000, which is not your address on Cosmos Hub.",
    ]);

    // Before: a transfer forwarded over the Hub's channel to the contract on Osmosis.
    const transfer = JSON.parse(ATOM_TO_OSMO_MSG) as BuiltMsg;
    const hooked = JSON.parse(ATOM_TO_OSMO_MEMO) as Record<string, unknown>;
    const viaHub = (receiver: string): BuiltMsg => ({
      ...transfer,
      value: {
        ...transfer.value,
        receiver: "cosmos1pfmintermediate000000000000000000000",
        memo: JSON.stringify({ forward: { receiver, port: "transfer", channel: "channel-141", next: hooked } }),
      },
    });
    const inbound = await reviewOf(
      "cosmoshub-4:uatom",
      "osmosis-1:uosmo",
      "1",
      quote({ inputDenom: ATOM_ON_OSMOSIS, inputAmount: "1000000", outputDenom: "uosmo", outputAmount: "4000000" }),
    );
    const pfm = confirmTerms(viaHub(XCS), inbound.review);
    expect(pfm.problems).toEqual([]);
    expect(pfm.facts?.forwardsIn.map((hop) => hop.channelId)).toEqual(["channel-141"]);
    expect(shownText(pfm.html)).toContain(
      "An IBC transfer, forwarded over channel-141, to Osmosis. When it arrives, its memo calls the swap contract.",
    );
    expect(confirmTerms(viaHub(OSMO_ADDRESS), inbound.review).problems).toEqual([
      "The transfer is not addressed to the swap contract, so the swap would not run and the tokens would land somewhere else.",
    ]);
  });

  it("says a minimum the message sets as a number, and a TWAP as its rule", async () => {
    const { review, message } = await osmoToAtom();
    const floor = withSwap(message, { slippage: { min_output_amount: "15000000" } });
    const { facts, problems, rows } = confirmTerms(floor, review);
    expect(problems).toEqual([]);
    expect(rows["Minimum received"]).toEqual(["15 ATOM"]);
    const minimum = minimumTerms(facts!.swap, boughtIdentity(facts!.swap.outputDenom, review.to), review.price.quote);
    expect(deliveryLine(review.to, minimum.exact)).toBe("Delivered on Cosmos Hub · at least 15 ATOM");
    // Without a price, the rule alone.
    const unpriced = { ...review, price: { ...review.price, quote: null } };
    expect(confirmTerms(message, unpriced).rows["Minimum received"]).toEqual(["The 10-second average price, less 1%"]);
  });
});

/* -------------------------------------------------------------------------- *
 * The confirm screen: the review it shows is the review it signs
 * -------------------------------------------------------------------------- */

describe("the review the confirm screen signs", () => {
  beforeEach(() => {
    install();
    clearInterchainCaches();
    resetChannelChecks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-05T12:00:00Z"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    clearInterchainCaches();
    resetChannelChecks();
  });

  const keyOf = (from: AssetOption, to: AssetOption, amountUnits: bigint, slippage = 1) =>
    swapPlanKey({ from, to, amountUnits, slippage, manual: [], contract: XCS, retryToken: 0 });

  /** A review made once the route table loaded, with the To nobody picked. */
  async function reviewWithAutoTo() {
    const from = row(sell, "cosmoshub-4:uatom");
    const to = pickTo(buy(from), null);
    if (!to) throw new Error("no To to review");
    const amountUnits = typed(from, "1");
    const { view, msg } = await signedBytes(request(from, to, amountUnits));
    const review = { from, to, amountUnits, plan: view, planKey: keyOf(from, to, amountUnits) };
    const live: LiveSwap = {
      from,
      to,
      amountUnits,
      planKey: review.planKey,
      plan: view,
      planning: false,
      blockedReason: null,
    };
    return { review, live, msg };
  }

  it("keeps the reviewed To when the list behind it picks another", async () => {
    const { review, live } = await reviewWithAutoTo();
    expect(review.to.key).toBe("osmosis-1:uosmo");
    expect(reviewDrift(review, live)).toBeNull();

    // The route table is read again and cannot be: an unpicked To would now
    // be the first row the bare list offers.
    const unread = buyOptions(chains, balances, { from: review.from, osmosis, routes: null });
    const repicked = pickTo(unread, null);
    expect(repicked?.key).toBe("safrochain-1:usaf");
    expect(
      reviewDrift(review, {
        ...live,
        to: repicked,
        planKey: keyOf(review.from, repicked!, review.amountUnits),
        plan: null,
        planning: true,
      }),
    ).toBe("The swap form no longer buys OSMO on Osmosis.");

    // Opening the review pins the pair it shows: the same list keeps the reviewed row.
    const pinned = pickTo(unread, review.to.key);
    expect(pinned?.key).toBe(review.to.key);
    expect(pinned).not.toBe(review.to);
    expect(reviewDrift(review, { ...live, to: pinned, planKey: keyOf(review.from, pinned!, review.amountUnits) })).toBeNull();
  });

  it("keeps standing through a balance refresh, and not through a change to what would be signed", async () => {
    const { review, live } = await reviewWithAutoTo();
    // A refresh rebuilds every row; the same key, amount and plan still stand.
    const refreshed = sellOptions(chains, { ...balances, "cosmoshub-4": { tokens: [{ denom: "uatom", amount: "2600000" }] } }, osmosis);
    const from = row(refreshed, review.from.key);
    expect(from).not.toBe(review.from);
    expect(reviewDrift(review, { ...live, from, planKey: keyOf(from, review.to, review.amountUnits) })).toBeNull();

    // The From is gone from the list, and another row stands in.
    expect(reviewDrift(review, { ...live, from: row(sell, "osmosis-1:uosmo") })).toBe(
      "The swap form no longer sells ATOM on Cosmos Hub.",
    );
    // The typed amount now reads as another number (its decimals turned unknown).
    expect(reviewDrift(review, { ...live, amountUnits: null })).toBe(
      "The amount on the swap form is no longer 1 ATOM.",
    );
    // The balance fell below the amount: the form cannot plan, and says why.
    expect(
      reviewDrift(review, { ...live, planKey: "", plan: null, blockedReason: "More than the ATOM left after the network fee." }),
    ).toBe("More than the ATOM left after the network fee.");
    // The slippage changed somewhere else.
    expect(reviewDrift(review, { ...live, planKey: keyOf(review.from, review.to, review.amountUnits, 2) })).toBe(
      "The swap's settings changed after this review.",
    );
    // The same inputs, planned again: the same route still stands, another does not.
    const again = { ...review.plan };
    expect(reviewDrift(review, { ...live, plan: again })).toBeNull();
    const rerouted = { ...review.plan, plan: { ...review.plan.plan, hops: review.plan.plan.hops.map((hop) => ({ ...hop, channelId: "channel-9" })) } };
    expect(reviewDrift(review, { ...live, plan: rerouted })).toBe(
      "Zunia planned the route again, and it is not the one you reviewed.",
    );
    expect(reviewDrift(review, { ...live, plan: null, planning: true })).toBe("Zunia is checking the route again.");
    expect(reviewDrift(review, { ...live, plan: { ...review.plan, blockedReason: "A channel failed its check." } })).toBe(
      "A channel failed its check.",
    );
  });

  it("signs only while the review stands and its price is fresh", () => {
    const price = { quote: quote(), error: null, code: null, at: Date.now() };
    const base = { problem: null, drift: null, price, priceError: null, refreshing: false, feeShort: false, now: Date.now() };
    expect(swapSignBlock(base)).toBeNull();
    expect(swapSignBlock({ ...base, drift: "The swap form no longer buys OSMO on Osmosis." })).toEqual({
      label: "Out of date",
      reason: "The swap form no longer buys OSMO on Osmosis. Go back and review the swap again.",
    });
    // What the message does that the review did not say comes first.
    expect(swapSignBlock({ ...base, problem: UNREADABLE_SWAP, drift: "x" })?.label).toBe("Cannot sign");
    expect(swapSignBlock({ ...base, refreshing: true })?.label).toBe("Updating the price…");
    expect(swapSignBlock({ ...base, price: { ...price, quote: null }, priceError: "No route." })).toEqual({
      label: "No price",
      reason: "No route.",
    });
    const stale = { ...base, now: price.at + QUOTE_TTL_MS };
    expect(priceExpired(price, stale.now)).toBe(true);
    expect(priceExpired(price, price.at + QUOTE_TTL_MS - 1)).toBe(false);
    expect(swapSignBlock(stale)).toEqual({ label: "Price expired", reason: PRICE_EXPIRED });
    expect(swapSignBlock({ ...base, feeShort: true })?.label).toBe("Need fee room");
  });

  it("describes and signs the reviewed message, whatever the form plans next", async () => {
    // Reviewed: 63 OSMO into ATOM, built once from the reviewed plan.
    const from = row(sell, "osmosis-1:uosmo");
    const to = row(buy(from), "cosmoshub-4:uatom");
    const amountUnits = typed(from, "63");
    const reviewed = await signedBytes(request(from, to, amountUnits));
    const review = { from, to, amountUnits, plan: reviewed.view, planKey: keyOf(from, to, amountUnits) };
    // The form moves on to 64 OSMO and plans that.
    resetChannelChecks();
    const next = await signedBytes(request(from, to, typed(from, "64")));
    expect(next.msg).not.toBe(reviewed.msg);
    const drift = reviewDrift(review, {
      from,
      to,
      amountUnits: typed(from, "64"),
      planKey: keyOf(from, to, typed(from, "64")),
      plan: next.view,
      planning: false,
      blockedReason: null,
    });
    expect(drift).toBe("The amount on the swap form is no longer 63 OSMO.");
    // The confirm screen still reads, and would sign, the message it opened with.
    expect(readSwapMessage(JSON.parse(reviewed.msg) as BuiltMsg)?.sold).toEqual({ denom: "uosmo", amount: "63000000" });
    expect(reviewed.msg).toBe(OSMO_TO_ATOM_MSG);
  });
});
