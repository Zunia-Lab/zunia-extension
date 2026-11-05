import type { RoutePlan } from "@zunialab/interchain";
import { describe, expect, it } from "vitest";

import { SKIP_ENTRY_POINT } from "../../config/interchain";
import { buildSwapFeeMsg } from "../swap-fee";
import {
  buildRelayTransferMsg,
  buildSkipSwapMemo,
  judgeEntryPoint,
  readRelayMsg,
  readSkipSwapMemo,
  relayMessageProblems,
  skipSwapTimeoutNs,
  type RelayExpectation,
  type SkipSwapArgs,
} from "../skip-swap";
import { isOneSignature, relaysToVenue, swapPathFor } from "../swap-path";
import { identityOf } from "../token-identity";

const SAF_ON_OSMOSIS = "ibc/DBAA4846F611A7603EFCE6F9F46F4F561D48B1F492A576022F000614A17089CE";
const ALL_USDC = "factory/osmo147h5x9pcj7lm0cttlaefx6sqq5vdfnmwfcqxkmjd7exqm9gc7grqhr75m0/alloyed/allUSDC";
const OSMO_ME = "osmo1emc0hs8lp84f2dmsje9xth8r4hw655t9u422ns";
const SAFRO_ME = "addr_safro1qyqszqgpqyqszqgpqyqszqgpqyqszqgpwdhzlz";
// The transfer's packet timeout is set from the real clock, so the review is checked at it too.
const NOW = Date.now();

/** 100 SAF on Safrochain sold for allUSDC in pool 3600, paid on Osmosis. */
const safToUsdc: SkipSwapArgs = {
  routes: [{ hops: [{ poolId: "3600", tokenOutDenom: ALL_USDC }], inAmount: "99500000" }],
  venueInputDenom: SAF_ON_OSMOSIS,
  venueOutputDenom: ALL_USDC,
  minOut: "46800",
  delivery: { kind: "osmosis", toAddress: OSMO_ME },
  timeoutNs: skipSwapTimeoutNs(NOW),
};

/** The checked hop Safrochain → Osmosis over channel-1. */
const inbound = {
  sourceChainId: "safrochain-1",
  destChainId: "osmosis-1",
  inputDenom: "usaf",
  outputDenom: SAF_ON_OSMOSIS,
  hops: [
    {
      kind: "transfer",
      chainId: "safrochain-1",
      counterpartyChainId: "osmosis-1",
      channelId: "channel-1",
      port: "transfer",
    },
  ],
  memo: "",
  warnings: [],
  estimatedDurationSeconds: 30,
  requiresPfm: false,
  requiresIbcHooks: false,
} as unknown as RoutePlan;

describe("the one-signature swap memo", () => {
  it("names Skip's entry point, the pools, the floor and a bare-number deadline", () => {
    const memo = buildSkipSwapMemo(safToUsdc);
    expect(memo).toBe(
      `{"wasm":{"contract":"${SKIP_ENTRY_POINT.address}","msg":{"swap_and_action":{"user_swap":{"swap_exact_asset_in":{"swap_venue_name":"osmosis-poolmanager","operations":[{"pool":"3600","denom_in":"${SAF_ON_OSMOSIS}","denom_out":"${ALL_USDC}"}]}},"min_asset":{"native":{"denom":"${ALL_USDC}","amount":"46800"}},"timeout_timestamp":${skipSwapTimeoutNs(NOW)},"post_swap_action":{"transfer":{"to_address":"${OSMO_ME}"}},"affiliates":[]}}}}`,
    );
    // A u64 the contract parses: a JSON number of 19 digits, never a string.
    expect(memo).toMatch(/"timeout_timestamp":\d{19},/);
    expect(skipSwapTimeoutNs(NOW)).toBe(BigInt(NOW + 15 * 60_000) * 1_000_000n);
  });

  it("sends the output on over the checked channel, recovering to the Osmosis address", () => {
    const memo = buildSkipSwapMemo({
      ...safToUsdc,
      delivery: { kind: "ibc", sourceChannel: "channel-750", receiver: "noble1me", recoverAddress: OSMO_ME },
    });
    expect(JSON.parse(memo).wasm.msg.swap_and_action.post_swap_action).toEqual({
      ibc_transfer: {
        ibc_info: { source_channel: "channel-750", receiver: "noble1me", memo: "", recover_address: OSMO_ME },
      },
    });
  });

  it("offers each route its share when the router splits the order", () => {
    const memo = buildSkipSwapMemo({
      ...safToUsdc,
      routes: [
        { hops: [{ poolId: "3600", tokenOutDenom: ALL_USDC }], inAmount: "60000000" },
        { hops: [{ poolId: "1", tokenOutDenom: "uosmo" }, { poolId: "1464", tokenOutDenom: ALL_USDC }], inAmount: "39500000" },
      ],
    });
    const swap = JSON.parse(memo).wasm.msg.swap_and_action.user_swap.smart_swap_exact_asset_in;
    expect(swap.routes[1]).toEqual({
      offer_asset: { native: { denom: SAF_ON_OSMOSIS, amount: "39500000" } },
      operations: [
        { pool: "1", denom_in: SAF_ON_OSMOSIS, denom_out: "uosmo" },
        { pool: "1464", denom_in: "uosmo", denom_out: ALL_USDC },
      ],
    });
    expect(readSkipSwapMemo(memo)?.routes.map((route) => route.inAmount)).toEqual(["60000000", "39500000"]);
  });

  it("reads back exactly what it built, the deadline's digits included", () => {
    const facts = readSkipSwapMemo(buildSkipSwapMemo(safToUsdc));
    expect(facts).toEqual({
      contract: SKIP_ENTRY_POINT.address,
      venueInputDenom: SAF_ON_OSMOSIS,
      routes: [{ hops: [{ poolId: "3600", tokenOutDenom: ALL_USDC }], inAmount: "" }],
      outputDenom: ALL_USDC,
      minOut: "46800",
      timeoutNs: skipSwapTimeoutNs(NOW),
      delivery: { kind: "osmosis", toAddress: OSMO_ME },
    });
  });

  it("refuses a memo with anything a review never shows", () => {
    const memo = buildSkipSwapMemo(safToUsdc);
    expect(readSkipSwapMemo(memo.replace('"affiliates":[]', '"affiliates":[{"basis_points_fee":"50","address":"osmo1x"}]'))).toBeNull();
    expect(readSkipSwapMemo(memo.replace(/"timeout_timestamp":(\d+)/, '"timeout_timestamp":"$1"'))).toBeNull();
    expect(readSkipSwapMemo(memo.replace("osmosis-poolmanager", "astroport"))).toBeNull();
    expect(readSkipSwapMemo(memo.replace('"to_address"', '"to_address":"osmo1x","extra"'))).toBeNull();
    expect(readSkipSwapMemo('{"forward":{}}')).toBeNull();
  });

  it("will not build a memo with no floor, a broken route or an address off Osmosis", () => {
    expect(() => buildSkipSwapMemo({ ...safToUsdc, minOut: "0" })).toThrow(/minimum/);
    expect(() => buildSkipSwapMemo({ ...safToUsdc, routes: [] })).toThrow(/route/);
    expect(() => buildSkipSwapMemo({ ...safToUsdc, delivery: { kind: "osmosis", toAddress: SAFRO_ME } })).toThrow(/Osmosis/);
  });
});

describe("the transfer that carries it", () => {
  const memo = buildSkipSwapMemo(safToUsdc);
  const msg = buildRelayTransferMsg({ inbound, sender: SAFRO_ME, amountBaseUnits: "99500000", memo });
  const expected: RelayExpectation = {
    chainId: "safrochain-1",
    denom: "usaf",
    net: "99500000",
    inbound,
    venueInputDenom: SAF_ON_OSMOSIS,
    venueOutputDenom: ALL_USDC,
    routes: safToUsdc.routes,
    minOut: "46800",
    delivery: safToUsdc.delivery,
  };
  const signing = { chainId: "safrochain-1", signerAddress: SAFRO_ME, now: NOW };

  it("goes to the entry point over the checked channel, the net amount, the memo verbatim", () => {
    expect(msg.typeUrl).toBe("/ibc.applications.transfer.v1.MsgTransfer");
    expect(msg.value).toMatchObject({
      source_port: "transfer",
      source_channel: "channel-1",
      token: { denom: "usaf", amount: "99500000" },
      sender: SAFRO_ME,
      receiver: SKIP_ENTRY_POINT.address,
      memo,
    });
    expect(relayMessageProblems(readRelayMsg(msg), expected, signing)).toEqual([]);
  });

  it("refuses a transfer to another contract, another amount, another floor or a lapsed deadline", () => {
    const facts = readRelayMsg(msg)!;
    const other = (value: Record<string, string>) => readRelayMsg({ ...msg, value: { ...msg.value, ...value } });
    expect(relayMessageProblems(other({ receiver: OSMO_ME }), expected, signing)).toContain(
      "The transfer goes to another contract than Skip's verified entry point.",
    );
    expect(relayMessageProblems(facts, { ...expected, net: "1" }, signing)).toContain(
      "The transfer sends another amount than the one reviewed.",
    );
    expect(relayMessageProblems(facts, { ...expected, minOut: "1" }, signing)).toContain(
      "The swap's minimum is not the one you reviewed.",
    );
    expect(relayMessageProblems(facts, expected, { ...signing, now: NOW + 20 * 60_000 })).toContain(
      "The swap's deadline has already passed. Refresh the price.",
    );
    expect(relayMessageProblems(facts, expected, { ...signing, chainId: "osmosis-1" }).length).toBeGreaterThan(0);
    expect(relayMessageProblems(null, expected, signing)).toHaveLength(1);
  });

  it("leaves the Zunia fee as today: its own bank send in the token sold", () => {
    const fee = buildSwapFeeMsg({ sender: SAFRO_ME, recipient: SAFRO_ME, denom: "usaf", amount: 500000n });
    expect(fee.typeUrl).toBe("/cosmos.bank.v1beta1.MsgSend");
    expect(readRelayMsg(fee)).toBeNull();
  });
});

describe("Skip's entry point, checked on chain", () => {
  const answer = (info: Record<string, unknown>) => ({
    address: SKIP_ENTRY_POINT.address,
    contract_info: { code_id: "1241", label: "Skip Swap Entry Point", admin: "", ...info },
  });

  it("is used only when the code id, the label and the empty admin all match", () => {
    expect(judgeEntryPoint(answer({})).ok).toBe(true);
    expect(judgeEntryPoint(answer({ code_id: "1300" })).ok).toBe(false);
    expect(judgeEntryPoint(answer({ label: "Something else" })).ok).toBe(false);
    expect(judgeEntryPoint(answer({ admin: "osmo1admin" })).reason).toMatch(/admin/);
    expect(judgeEntryPoint(null).ok).toBe(false);
  });
});

describe("which swaps take one signature", () => {
  const saf = { chainId: "safrochain-1", identity: identityOf("safrochain-1", "usaf") };
  const atom = { chainId: "cosmoshub-4", identity: identityOf("cosmoshub-4", "uatom") };

  it("relays SAF on Safrochain to USDC on Osmosis, and to SAF's own chain back", () => {
    expect(saf.identity.osmosisDenom).toBe(SAF_ON_OSMOSIS);
    expect(relaysToVenue(saf)).toBe(true);
    expect(swapPathFor(saf, { chainId: "osmosis-1" }, "no")).toBe("relay");
    expect(swapPathFor(saf, { chainId: "noble-1" }, "unknown")).toBe("relay");
    expect(isOneSignature("relay", "no")).toBe(true);
    expect(swapPathFor(atom, { chainId: "osmosis-1" }, "yes")).toBe("relay");
  });

  it("keeps the pools for funds on Osmosis, and moves a voucher held elsewhere first", () => {
    const allUsdc = { chainId: "osmosis-1", identity: identityOf("osmosis-1", ALL_USDC) };
    expect(swapPathFor(allUsdc, { chainId: "safrochain-1" }, "no")).toBe("pool-deliver");
    const voucher = { chainId: "safrochain-1", identity: { originChainId: "noble-1", osmosisDenom: "ibc/498A", testnet: false } };
    expect(relaysToVenue(voucher)).toBe(false);
    expect(swapPathFor(voucher, { chainId: "osmosis-1" }, "no")).toBe("move-first");
    expect(isOneSignature("move-first", "no")).toBe(false);
  });
});
