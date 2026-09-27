import { describe, expect, it } from "vitest";

import { EXPLORER_TX_URLS, explorerTxUrl } from "../../config/interchain";
import { findCatalogEntry } from "../chain-catalog";
import { buildTransferMsgFromPlan, pathHopViews, type RoutePlanView } from "../route-plan";

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
