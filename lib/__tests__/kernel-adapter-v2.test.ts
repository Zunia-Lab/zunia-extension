/**
 * How lib/kernel.ts reads the wasm kernel's decodeDirectTx, on stub payloads.
 *
 * - Kernel 0.1.0 returns summaries only. Its reading must not change: the
 *   expected objects below are what the adapter returned before payload v2
 *   existed, recorded from it.
 * - Kernel 0.1.1 returns payload v2: one object per message, with its type URL,
 *   recipient and detail, plus the fee and the account number.
 */
import { describe, expect, it } from "vitest";

import { adaptWasmKernel, createLocalKernel, type DecodedDirectTx } from "../kernel";

function adapt(payload: unknown): DecodedDirectTx {
  const mod = { decodeDirectTx: () => payload } as unknown as typeof import("@zunialab/core");
  return adaptWasmKernel(mod, createLocalKernel(), "test").decodeDirectTx("00");
}

const TO = "cosmos1jrkmdcwgq94uaamx6zax2luewlhf7u4kucx3kz";
const SEND = `Send 1000000 uatom to ${TO}`;
const UNREADABLE = "UNKNOWN ACTION: /cosmwasm.wasm.v1.MsgExecuteContract (126 bytes the wallet cannot read)";
const XCS = "osmo1uwk8xc6q0s6t5qcpr6rht3sczu6du83xq8pwxjua0hfj5hzcnh3sqxwvxs";
const RECOVER = `Execute "recover" on ${XCS}`;
const TRANSFER = "IBC transfer 1 uatom to osmo1receiver over channel-141";
const MEMO = '{"forward":{"receiver":"stride1x","port":"transfer","channel":"channel-5"}}';

const v1 = (summaries: string[], extra: Record<string, unknown> = {}) => ({
  chainId: "cosmoshub-4",
  memo: "",
  hasUnknownMsgs: summaries.some((summary) => summary.startsWith("UNKNOWN ACTION:")),
  safeWithoutBlindSigning: !summaries.some((summary) => summary.startsWith("UNKNOWN ACTION:")),
  summaries,
  addresses: [],
  ...extra,
});

type V2Message = { typeUrl: string; summary: string; unknown: boolean; recipient?: string; detail?: unknown };

const v2 = (messages: V2Message[], extra: Record<string, unknown> = {}) => ({
  ...v1(messages.map((message) => message.summary)),
  hasUnknownMsgs: messages.some((message) => message.unknown),
  accountNumber: "12345",
  sequence: "7",
  timeoutHeight: "0",
  fee: { amount: [{ denom: "uatom", amount: "5000" }], gasLimit: "200000" },
  messages,
  ...extra,
});

const send: V2Message = { typeUrl: "/cosmos.bank.v1beta1.MsgSend", summary: SEND, unknown: false, recipient: TO };
const recover: V2Message = {
  typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
  summary: RECOVER,
  unknown: false,
  detail: { kind: "execute-contract", contract: XCS, msg: { recover: {} }, funds: [] },
};
const transfer: V2Message = {
  typeUrl: "/ibc.applications.transfer.v1.MsgTransfer",
  summary: TRANSFER,
  unknown: false,
  recipient: "osmo1receiver",
  detail: { kind: "ibc-transfer", sourceChannel: "channel-141", receiver: "osmo1receiver", token: { denom: "uatom", amount: "1" }, memo: MEMO },
};
const grant: V2Message = {
  typeUrl: "/cosmos.authz.v1beta1.MsgGrant",
  summary: "UNKNOWN ACTION: /cosmos.authz.v1beta1.MsgGrant (3 bytes the wallet cannot read)",
  unknown: true,
};

describe("kernel 0.1.0: summaries only, read as before", () => {
  it("a known message: no type URL, no fee, account number 0", () => {
    expect(adapt(v1([SEND], { memo: "for lunch" }))).toStrictEqual({
      chainId: "cosmoshub-4",
      accountNumber: "0",
      messages: [{ typeUrl: "", summary: SEND }],
      memo: "for lunch",
    });
  });

  it("an unknown message is named from its summary", () => {
    expect(adapt(v1([SEND, UNREADABLE], { chainId: "osmosis-1" }))).toStrictEqual({
      chainId: "osmosis-1",
      accountNumber: "0",
      messages: [
        { typeUrl: "", summary: SEND },
        { typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract", summary: UNREADABLE, unknown: true },
      ],
      memo: "",
    });
  });

  it("unknown messages no summary owns up to make every message unknown", () => {
    expect(adapt(v1([SEND, "Delegate 1 uatom to v"], { chainId: "osmosis-1", memo: "x", hasUnknownMsgs: true }))).toStrictEqual({
      chainId: "osmosis-1",
      accountNumber: "0",
      messages: [
        { typeUrl: "", summary: SEND, unknown: true },
        { typeUrl: "", summary: "Delegate 1 uatom to v", unknown: true },
      ],
      memo: "x",
    });
  });
});

describe("kernel 0.1.1: payload v2", () => {
  it("reads each message's type URL, recipient and detail, the fee and the account number", () => {
    expect(adapt(v2([send, recover, transfer], { memo: "for lunch" }))).toStrictEqual({
      chainId: "cosmoshub-4",
      accountNumber: "12345",
      messages: [
        { typeUrl: "/cosmos.bank.v1beta1.MsgSend", summary: SEND, recipient: TO },
        { typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract", summary: RECOVER, detail: recover.detail },
        { typeUrl: "/ibc.applications.transfer.v1.MsgTransfer", summary: TRANSFER, recipient: "osmo1receiver", detail: transfer.detail },
      ],
      memo: "for lunch",
      fee: { amount: [{ denom: "uatom", amount: "5000" }], gas: "200000" },
    });
  });

  it("keeps nothing but the type and summary of an unknown message", () => {
    const tampered: V2Message = { ...grant, recipient: "cosmos1somebody", detail: { kind: "ibc-transfer", sourceChannel: "c", receiver: "r", token: null, memo: "m" } };
    expect(adapt(v2([send, tampered])).messages).toStrictEqual([
      { typeUrl: "/cosmos.bank.v1beta1.MsgSend", summary: SEND, recipient: TO },
      { typeUrl: "/cosmos.authz.v1beta1.MsgGrant", summary: grant.summary, unknown: true },
    ]);
  });

  it("gates a message whose summary admits it is unreadable, whatever its flag says", () => {
    const flaggedOff: V2Message = { ...grant, unknown: false };
    expect(adapt(v2([flaggedOff])).messages).toStrictEqual([{ typeUrl: grant.typeUrl, summary: grant.summary, unknown: true }]);
  });

  it("makes every message unknown when the transaction is, and no message owns up to it", () => {
    expect(adapt(v2([send, recover], { hasUnknownMsgs: true })).messages).toStrictEqual([
      { typeUrl: "/cosmos.bank.v1beta1.MsgSend", summary: SEND, unknown: true },
      { typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract", summary: RECOVER, unknown: true },
    ]);
  });

  it("reads every coin of a fee, which the chain deducts all of, never a fee in several by its first", () => {
    const twoCoins = { amount: [{ denom: "uion", amount: "1" }, { denom: "uosmo", amount: "1000000000" }], gasLimit: "250000" };
    expect(adapt(v2([send], { fee: twoCoins })).fee).toStrictEqual({
      amount: [
        { denom: "uion", amount: "1" },
        { denom: "uosmo", amount: "1000000000" },
      ],
      gas: "250000",
    });
    expect(adapt(v2([send], { fee: { amount: [], gasLimit: "200000" } })).fee).toStrictEqual({ amount: [], gas: "200000" });
  });

  it("names no fee when one of its coins is not a coin", () => {
    const odd = { amount: [{ denom: "uatom", amount: "5000" }, { denom: "uosmo", amount: 1 }], gasLimit: "200000" };
    expect(adapt(v2([send], { fee: odd }))).not.toHaveProperty("fee");
    expect(adapt(v2([send], { fee: { amount: [null], gasLimit: "200000" } }))).not.toHaveProperty("fee");
  });

  it("drops a detail it does not know, or one missing what the prompt reads", () => {
    const odd = (detail: unknown): V2Message => ({ ...recover, detail });
    for (const detail of [
      { kind: "governance-proposal", id: 1 },
      { kind: "execute-contract", contract: XCS, funds: [] },
      { kind: "execute-contract", contract: XCS, msg: {}, funds: "none" },
      { kind: "ibc-transfer", sourceChannel: "channel-141", receiver: "osmo1receiver", token: null },
      "execute-contract",
      null,
    ]) {
      expect(adapt(v2([odd(detail)])).messages).toStrictEqual([{ typeUrl: recover.typeUrl, summary: RECOVER }]);
    }
  });

  it("reads a payload whose messages do not match its summaries one for one as 0.1.0's", () => {
    const short = { ...v2([send, recover]), summaries: [SEND] };
    expect(adapt(short).messages).toStrictEqual([{ typeUrl: "", summary: SEND }]);
    const reworded = { ...v2([send]), summaries: ["Send 2 uatom to someone else"] };
    expect(adapt(reworded)).toStrictEqual({
      chainId: "cosmoshub-4",
      accountNumber: "0",
      messages: [{ typeUrl: "", summary: "Send 2 uatom to someone else" }],
      memo: "",
    });
    const noFee = { ...v2([send]), fee: undefined };
    expect(adapt(noFee).accountNumber).toBe("0");
  });
});
