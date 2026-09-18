import { describe, expect, it } from "vitest";

import { explorerTxUrl } from "../../config/interchain";
import { buildTransferMsgFromPlan, type RoutePlanView } from "../route-plan";

/**
 * The one piece of wire shape this client writes by hand.
 *
 * `@zunialab/interchain` builds the plan and the memo but has no ICS20 message
 * builder, so `buildTransferMsgFromPlan` produces the proto-JSON that
 * zunia-core's `msg_from_proto_json` parses. A field renamed here fails on
 * chain as an opaque decode error after the user has approved, which is exactly
 * the failure these assertions exist to catch.
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

  it("refuses a plan whose first hop is not a transfer the user can sign", () => {
    expect(() =>
      buildTransferMsgFromPlan({
        view: view({ kind: "swap" }),
        sender: "addr_safro1sender",
        amountBaseUnits: "5",
      }),
    ).toThrow(/no transfer/i);
  });
});

describe("explorerTxUrl", () => {
  it("returns null rather than a guessed explorer domain", () => {
    // The shipped registry fork carries no explorer URLs. A link that 404s or
    // points at somebody else's chain is worse than plain selectable text.
    expect(explorerTxUrl("osmosis-1", "ABC")).toBeNull();
  });
});
