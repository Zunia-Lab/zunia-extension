import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { bech32 } from "@scure/base";
import type { BuiltMsg, OsmosisSwapQuote } from "@zunialab/interchain";

import { findCatalogEntry } from "../../../lib/chain-catalog";
import { osmosisSwapAssets, parseOsmosisTokenMetadata } from "../../../lib/osmosis-assets";
import { POOL_SPLIT_SWAP_TYPE_URL, POOL_SWAP_TYPE_URL, readDeliveryTransfer, readPoolSwapMsg, type PoolRoute } from "../../../lib/pool-swap";
import type { RoutePlanView } from "../../../lib/route-plan";
import { BANK_SEND_TYPE_URL, buildSwapFeeMsg, readSwapFeeMsg, swapFeeFor, type SwapFeeRecipients } from "../../../lib/swap-fee";
import { buyOptions, sellOptions, type AssetOption, type HeldBalance, type SwapChain } from "../../../lib/swap-assets";
import { parseRouterState, type XcsRouteTable } from "../../../lib/xcs-routes";
import sqs from "../../../lib/__tests__/fixtures/swap/sqs-tokens-metadata.json";
import wallet from "../../../lib/__tests__/fixtures/swap/wallet.json";
import live from "../../../lib/__tests__/fixtures/swap/xcs-route-table.json";
import {
  EXTRA_MESSAGES,
  PoolSwapTerms,
  ReviewDisclosure,
  ReviewProblems,
  SwapReviewCard,
  UNREADABLE_DELIVERY,
  UNREADABLE_SWAP,
  poolReviewSummary,
  poolFeeOutcome,
  poolQuoteText,
  poolReviewDrift,
  poolSwapTermsProblems,
  poolSwapTxMsgs,
  reviewJson,
  type LivePoolSwap,
  type ReviewedPoolSwap,
} from "./SwapScreen";

/**
 * The swap screen's pool path (lib/pool-swap.ts): OSMO on Osmosis to USDC.inj,
 * on Osmosis (`pool`) and delivered home to Injective (`pool-deliver`). What
 * the screen signs, the check that refuses anything the review did not say,
 * when a review stops standing, and the terms panel that reads the messages.
 *
 * The rows are the real lists over the WP-D1 fixtures; the treasury map is
 * the test's own.
 */

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

const USDC_INJ = "ibc/794C7D7F3B857713878A3A1927251FA6AC1EEE520424C1F6FAFE9BA26D476138";
const USDC_INJ_ERC20 = "erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a";
const address = (prefix: string, fill: number) => bech32.encode(prefix, bech32.toWords(new Uint8Array(20).fill(fill)));
const ME = address("osmo", 7);
const ME_ON_INJECTIVE = address("inj", 7);
const STRANGER = address("osmo", 8);
const TREASURY = address("osmo", 9);
const FEES: SwapFeeRecipients = { "osmosis-1": TREASURY };
const NOW = 1_791_300_000_000;

const osmo = row(sell, "osmosis-1:uosmo");
const fromOsmo = buyOptions(chains, balances, { from: osmo, osmosis, routes });
const usdcInjOnOsmosis = row(fromOsmo, `osmosis-1:${USDC_INJ}`);
const usdcInjHome = row(fromOsmo, `injective-1:${USDC_INJ_ERC20}`);

const ROUTES: PoolRoute[] = [
  { hops: [{ poolId: "3498", tokenOutDenom: USDC_INJ }], inAmount: "5970000" },
  { hops: [{ poolId: "3586", tokenOutDenom: USDC_INJ }], inAmount: "3980000" },
];
const QUOTE = {
  inputDenom: "uosmo",
  inputAmount: "9950000",
  outputDenom: USDC_INJ,
  outputAmount: "352860",
  priceImpact: 0.39,
  poolFee: 0.8,
  minReceived: "349331",
  slippagePercent: 1,
  route: [{ poolId: "3498", tokenOutDenom: USDC_INJ }],
  source: "router",
  splits: [],
  spotPrice: "0.0358",
  effectiveFeeFraction: "0.008",
  warnings: [],
  fetchedAt: NOW,
} as OsmosisSwapQuote;

/** The checked leg home to Injective, as lib/pool-swap.ts `planPoolDelivery` returns it. */
const HOME: RoutePlanView = {
  plan: {
    sourceChainId: "osmosis-1",
    destChainId: "injective-1",
    inputDenom: USDC_INJ,
    outputDenom: USDC_INJ_ERC20,
    hops: [{ chainId: "osmosis-1", channelId: "channel-122", port: "transfer", counterpartyChainId: "injective-1", kind: "transfer" }],
    memo: "",
    warnings: [],
    estimatedDurationSeconds: 60,
    requiresPfm: false,
    requiresIbcHooks: false,
  },
  receiver: ME_ON_INJECTIVE,
  hops: [],
  warnings: [],
  blockedReason: null,
  failedCheck: null,
} as unknown as RoutePlanView;

function review(path: "pool" | "pool-deliver", overrides: Partial<ReviewedPoolSwap> = {}): ReviewedPoolSwap {
  const to = path === "pool" ? usdcInjOnOsmosis : usdcInjHome;
  return {
    id: 1,
    path,
    from: osmo,
    to,
    amountUnits: 10_000_000n,
    fee: swapFeeFor("osmosis-1", 10_000_000n, FEES),
    venueOutputDenom: USDC_INJ,
    slippagePercent: 1,
    price: { quote: QUOTE, at: NOW },
    routes: ROUTES,
    minOut: "349331",
    delivery: path === "pool" ? null : HOME,
    signer: ME,
    recipient: path === "pool" ? ME : ME_ON_INJECTIVE,
    planKey: `key-${path}`,
    ...overrides,
  };
}

function signed(target: ReviewedPoolSwap): BuiltMsg[] {
  return poolSwapTxMsgs({
    sender: ME,
    denom: target.from.denom,
    routes: target.routes,
    minOut: target.minOut,
    fee: target.fee,
    delivery: target.delivery,
  });
}

function problems(target: ReviewedPoolSwap, msgs: readonly BuiltMsg[], at = NOW): string[] {
  return poolSwapTermsProblems(readPoolSwapMsg(msgs[0]), target, {
    chainId: "osmosis-1",
    signerAddress: ME,
    msgs,
    recipients: FEES,
    now: at,
  });
}

describe("what a pool swap signs", () => {
  it("swaps what is left after the fee, then pays the fee, in one transaction", () => {
    const target = review("pool");
    expect(target.fee).toMatchObject({ fee: 50_000n, net: 9_950_000n, recipient: TREASURY });
    const msgs = signed(target);
    expect(msgs.map((msg) => msg.typeUrl)).toEqual([POOL_SPLIT_SWAP_TYPE_URL, BANK_SEND_TYPE_URL]);
    expect(readPoolSwapMsg(msgs[0])).toMatchObject({ sender: ME, sold: { denom: "uosmo", amount: "9950000" }, minOut: "349331" });
    expect(readSwapFeeMsg(msgs[1])).toEqual({ from: ME, to: TREASURY, denom: "uosmo", amount: "50000" });
    expect(problems(target, msgs)).toEqual([]);
  });

  it("is the swap alone when no fee is due", () => {
    const free = review("pool", { fee: swapFeeFor("osmosis-1", 10_000_000n, {}) });
    const msgs = poolSwapTxMsgs({ sender: ME, denom: "uosmo", routes: [{ ...ROUTES[0]!, inAmount: "10000000" }], minOut: "1", fee: free.fee, delivery: null });
    expect(msgs.map((msg) => msg.typeUrl)).toEqual([POOL_SWAP_TYPE_URL]);
  });

  it("sends exactly the floor home after the swap when the To is on another chain", () => {
    const target = review("pool-deliver");
    const msgs = signed(target);
    expect(msgs.map((msg) => msg.typeUrl)).toEqual([
      POOL_SPLIT_SWAP_TYPE_URL,
      BANK_SEND_TYPE_URL,
      "/ibc.applications.transfer.v1.MsgTransfer",
    ]);
    expect(readDeliveryTransfer(msgs[2])).toMatchObject({
      sourceChannel: "channel-122",
      token: { denom: USDC_INJ, amount: "349331" },
      sender: ME,
      receiver: ME_ON_INJECTIVE,
      memo: "",
    });
    expect(problems(target, msgs, Date.now())).toEqual([]);
  });
});

describe("what the review did not say refuses the signature", () => {
  const target = review("pool");
  const msgs = signed(target);
  const swapValue = msgs[0]!.value as Record<string, unknown>;
  const withSwap = (value: Record<string, unknown>): BuiltMsg[] => [{ ...msgs[0]!, value: value as never }, ...msgs.slice(1)];

  it("refuses a message it cannot read, and anything after the swap and its fee", () => {
    expect(problems(target, withSwap({ ...swapValue, extra: 1 }))).toEqual([UNREADABLE_SWAP]);
    expect(problems(target, [...msgs, msgs[1]!])).toEqual([EXTRA_MESSAGES]);
  });

  it("names a swap that spends from another account, another amount, or buys another token", () => {
    expect(problems(target, withSwap({ ...swapValue, sender: STRANGER }))[0]).toMatch(/would spend from osmo1/);
    const fewer = { ...swapValue, routes: [{ pools: [{ pool_id: "3498", token_out_denom: USDC_INJ }], token_in_amount: "1" }, { pools: [{ pool_id: "3586", token_out_denom: USDC_INJ }], token_in_amount: "3980000" }] };
    expect(problems(target, withSwap(fewer)).join(" ")).toMatch(/spends .*not the 9\.95 OSMO you reviewed/);
    const other = { ...swapValue, routes: [{ pools: [{ pool_id: "1", token_out_denom: "uion" }], token_in_amount: "9950000" }] };
    expect(problems(target, withSwap(other)).join(" ")).toMatch(/would buy .*not the USDC\.inj you picked/);
  });

  it("names another floor or other pools than the ones reviewed", () => {
    expect(problems(target, withSwap({ ...swapValue, token_out_min_amount: "1" })).join(" ")).toMatch(/minimum is/);
    const shuffled = { ...swapValue, routes: [...(swapValue.routes as unknown[])].reverse() };
    expect(problems(target, withSwap(shuffled)).join(" ")).toMatch(/other pools, or other amounts/);
  });

  it("refuses a pool swap reviewed as delivering anywhere but the signer", () => {
    expect(problems(review("pool", { recipient: STRANGER }), msgs).join(" ")).toMatch(/pays a swap to the account that signs it/);
  });

  it("holds the fee to the one Zunia charges", () => {
    const wrongFee = [msgs[0]!, buildSwapFeeMsg({ sender: ME, recipient: STRANGER, denom: "uosmo", amount: 50_000n })];
    expect(problems(target, wrongFee).join(" ")).toMatch(/not Zunia's fee address/);
    expect(problems(target, [msgs[0]!]).join(" ")).toMatch(/leaves out the 0\.05 OSMO Zunia fee/);
  });

  it("checks the transfer home: its receiver, amount, channel, memo and timeout", () => {
    const home = review("pool-deliver");
    const sent = signed(home);
    const transfer = sent[2]!.value as Record<string, unknown>;
    const withTransfer = (value: Record<string, unknown>) => [sent[0]!, sent[1]!, { ...sent[2]!, value: value as never }];
    const at = Date.now();
    expect(problems(home, withTransfer({ ...transfer, receiver: address("inj", 8) }), at).join(" ")).toMatch(/not your address on Injective/);
    expect(problems(home, withTransfer({ ...transfer, token: { denom: USDC_INJ, amount: "349332" } }), at).join(" ")).toMatch(/not the swap's minimum/);
    expect(problems(home, withTransfer({ ...transfer, source_channel: "channel-0" }), at).join(" ")).toMatch(/not over channel-122/);
    expect(problems(home, withTransfer({ ...transfer, memo: "{}" }), at).join(" ")).toMatch(/carries a memo/);
    expect(problems(home, withTransfer({ ...transfer, timeout_timestamp: "1" }), at).join(" ")).toMatch(/timeout has already passed/);
    expect(problems(home, [sent[0]!, sent[1]!], at)).toContain(UNREADABLE_DELIVERY);
  });
});

describe("whether a pool review still stands", () => {
  const target = review("pool-deliver");
  const live = (overrides: Partial<LivePoolSwap> = {}): LivePoolSwap => ({
    from: target.from,
    to: target.to,
    path: "pool-deliver",
    amountUnits: target.amountUnits,
    fee: target.fee,
    planKey: target.planKey,
    planning: false,
    delivery: { view: HOME, error: null },
    blockedReason: null,
    ...overrides,
  });

  it("stands while the form would sign the same swap, whatever the price does", () => {
    expect(poolReviewDrift(target, live())).toBeNull();
  });

  it("names what moved", () => {
    expect(poolReviewDrift(target, live({ to: usdcInjOnOsmosis }))).toMatch(/no longer buys USDC\.inj on Injective/);
    expect(poolReviewDrift(target, live({ amountUnits: 1n }))).toMatch(/no longer 10 OSMO/);
    expect(poolReviewDrift(target, live({ path: "contract" }))).toMatch(/another way/);
    expect(poolReviewDrift(target, live({ planKey: "other" }))).toMatch(/settings changed/);
    expect(poolReviewDrift(target, live({ planning: true }))).toMatch(/checking the transfer again/);
    expect(poolReviewDrift(target, live({ delivery: { view: null, error: "Channel closed." } }))).toBe("Channel closed.");
    const elsewhere = { ...HOME, plan: { ...HOME.plan, hops: [{ ...HOME.plan.hops[0]!, channelId: "channel-9" }] } } as RoutePlanView;
    expect(poolReviewDrift(target, live({ delivery: { view: elsewhere, error: null } }))).toMatch(/planned the transfer again/);
  });
});

describe("the words", () => {
  it("names the pools' own reasons with the tickers on screen", () => {
    expect(poolQuoteText("no-pool-route", "x", osmo, usdcInjOnOsmosis)).toBe(
      "Osmosis has no pool route from OSMO to USDC.inj at this amount, so there is nothing to sign.",
    );
    expect(poolQuoteText(null, "the module's words", osmo, usdcInjOnOsmosis)).toBe("the module's words");
  });

  it("says where the output ends up, and what becomes of the rest", () => {
    // On Osmosis: about the quote, at least the floor.
    expect(poolReviewSummary(review("pool"), null)).toMatchObject({
      pay: "10 OSMO",
      receive: "≈ 0.35286 USDC.inj",
      receiveLine: "Delivered on Osmosis",
      minimum: { value: "0.349331 USDC.inj", note: null },
      zuniaFee: { amount: "0.05 OSMO", rate: "0.5%" },
    });
    // Home to Injective: exactly the floor arrives, and the rest is named.
    expect(poolReviewSummary(review("pool-deliver"), null)).toMatchObject({
      receive: "0.349331 USDC.inj",
      receiveLine: "Delivered on Injective · about 0.003529 USDC.inj more stays on Osmosis",
      minimum: null,
    });
    expect(poolFeeOutcome("pool")).toMatch(/no fee is taken/);
    expect(poolFeeOutcome("pool-deliver")).toMatch(/none of them happens/);
  });
});

describe("the terms panel", () => {
  it("reads the swap, the transfer and the fee out of the messages", () => {
    const target = review("pool-deliver");
    const msgs = signed(target);
    const html = renderToStaticMarkup(
      createElement(PoolSwapTerms, {
        facts: readPoolSwapMsg(msgs[0]),
        review: target,
        problems: [],
        onCopy: () => undefined,
        fee: readSwapFeeMsg(msgs[1]),
        transfer: readDeliveryTransfer(msgs[2]),
      }),
    );
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    for (const piece of [
      "What the transaction does",
      "Sells",
      "9.95 OSMO",
      "Buys",
      "Through",
      "2 routes: pool 3498 (60%) and pool 3586 (40%)",
      "Minimum received",
      "Pays out to",
      "Your address on Osmosis",
      "Then",
      "over channel-122",
      "Your address on Injective",
      "If delivery fails",
      "Zunia fee",
      "none of them happens",
    ]) {
      expect(text).toContain(piece);
    }
  });

  it("says nothing it cannot read", () => {
    const html = renderToStaticMarkup(
      createElement(PoolSwapTerms, { facts: null, review: review("pool"), problems: [], onCopy: () => undefined }),
    );
    expect(html).toContain(UNREADABLE_SWAP.replace(/'/g, "&#x27;"));
  });
});

describe("the confirm screen's layout", () => {
  const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

  it("leads with what is paid, what comes back, the minimum, the rate and the fees", () => {
    const html = renderToStaticMarkup(
      createElement(SwapReviewCard, {
        summary: poolReviewSummary(review("pool"), null),
        networkFee: createElement("span", null, "Network fee 0.004 OSMO"),
        clock: createElement("span", null, "Price valid for 18s"),
      }),
    );
    const shown = text(html);
    for (const piece of [
      "You pay",
      "10 OSMO",
      "Held on Osmosis",
      "You receive",
      "≈ 0.35286 USDC.inj",
      "Delivered on Osmosis",
      "Minimum received",
      "0.349331 USDC.inj",
      "Rate",
      "Zunia fee (0.5%)",
      "0.05 OSMO",
      "Network fee 0.004 OSMO",
      "Price valid for 18s",
    ]) {
      expect(shown).toContain(piece);
    }
    // Nothing about contracts, pools, addresses or messages up there.
    expect(shown).not.toMatch(/pool 3498|osmo1|Exact message|MsgSplit/);
  });

  it("folds the details and the JSON away, closed until the user opens them", () => {
    const html = renderToStaticMarkup(
      createElement(ReviewDisclosure, { title: "Transaction details", hint: "pools, addresses, messages", children: "inside" }),
    );
    expect(html).toMatch(/^<details class="group/);
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(text(html)).toContain("Transaction details");
    expect(html).toContain("inside");
  });

  it("never folds away what stops the signature", () => {
    expect(renderToStaticMarkup(createElement(ReviewProblems, { problems: [] }))).toBe("");
    const html = renderToStaticMarkup(createElement(ReviewProblems, { problems: [UNREADABLE_SWAP, EXTRA_MESSAGES] }));
    expect(html).not.toContain("<details");
    expect(text(html)).toContain("Zunia will not sign this");
    expect(text(html)).toContain(UNREADABLE_SWAP);
    expect(text(html)).toContain(EXTRA_MESSAGES);
  });

  it("puts the whole transaction in the JSON, a contract call's message decoded beside it", () => {
    const msgs = signed(review("pool-deliver"));
    const preview = { fee: { amount: [{ denom: "uosmo", amount: "4000" }], gas: "400000" }, preview: { memo: "Swap OSMO to USDC.inj · by Zunia-wallet" } };
    const parsed = JSON.parse(reviewJson("osmosis-1", msgs, preview as never)) as { chain_id: string; memo: string; messages: unknown[] };
    expect(parsed.chain_id).toBe("osmosis-1");
    expect(parsed.memo).toBe("Swap OSMO to USDC.inj · by Zunia-wallet");
    expect(parsed.messages).toEqual(JSON.parse(JSON.stringify(msgs)));
    const call: BuiltMsg = {
      typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
      value: { sender: ME, contract: STRANGER, msg: Buffer.from('{"osmosis_swap":{}}').toString("base64"), funds: [] },
    };
    const withCall = JSON.parse(reviewJson("osmosis-1", [call], preview as never)) as { messages: { decodedMsg?: unknown }[] };
    expect(withCall.messages[0]?.decodedMsg).toEqual({ osmosis_swap: {} });
  });
});
