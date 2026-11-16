/**
 * What the signing prompt does with the dApp messages in Amino mode: the same sentences as the
 * kernel gives in direct mode, the recipients the first-time warning reads, the details the raw
 * transaction shows, and the blind-signing gate for a message nothing reads.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { bech32 } from "@scure/base";

import { decodeAminoSignDoc } from "../signing";

const address = (prefix: string, bytes: number, seed = 1): string =>
  bech32.encode(prefix, bech32.toWords(Uint8Array.from({ length: bytes }, (_, i) => (i * 7 + seed) & 0xff)));
const ME = address("osmo", 20);
const NEW_ADMIN = address("osmo", 20, 2);
const CONTRACT = address("osmo", 32, 3);
const OUT_A = address("osmo", 20, 5);
const OUT_B = address("osmo", 20, 6);

afterEach(() => {
  vi.unstubAllGlobals();
});

function sign(msgs: Array<{ type: string; value: Record<string, unknown> }>, known: string[] = []) {
  vi.stubGlobal("browser", {
    storage: {
      local: {
        get: async (key: string) => (key === "zunia.knownRecipients" ? { [key]: known } : {}),
        set: async () => undefined,
      },
      onChanged: { addListener: () => undefined },
    },
  });
  return decodeAminoSignDoc("osmosis-1", {
    chain_id: "osmosis-1",
    account_number: "7",
    sequence: "3",
    memo: "",
    fee: { amount: [{ denom: "uosmo", amount: "5000" }], gas: "200000" },
    msgs,
  });
}

const coins = (amount: string) => [{ denom: "uosmo", amount }];

describe("a concentrated liquidity position, as Safrochain Hub asks for it", () => {
  it("is read in words and needs no blind signing", async () => {
    const summary = await sign([
      {
        type: "osmosis/cl-create-position",
        value: { pool_id: "3600", sender: ME, lower_tick: "-100", upper_tick: "200", tokens_provided: coins("5"), token_min_amount0: "0", token_min_amount1: "0" },
      },
    ]);
    expect(summary.requiresBlindSigning).toBe(false);
    expect(summary.messages[0]).toMatchObject({
      type: "osmosis/cl-create-position",
      summary: "Create a concentrated liquidity position in pool 3600 between ticks -100 and 200 with 5 uosmo, accepting at least 0 of the pool's token0 and 0 of its token1",
    });
    expect(summary.messages[0]?.unknown).toBeUndefined();
    expect(summary.warnings).toEqual([]);
  });

  it("is gated, with the generic line, once it breaks a rule the kernel holds it to", async () => {
    const summary = await sign([
      {
        type: "osmosis/cl-create-position",
        value: { pool_id: "0", sender: ME, lower_tick: "-100", upper_tick: "200", tokens_provided: coins("5"), token_min_amount0: "0", token_min_amount1: "0" },
      },
    ]);
    expect(summary.requiresBlindSigning).toBe(true);
    expect(summary.messages[0]).toMatchObject({ summary: "Message osmosis/cl-create-position", unknown: true });
  });
});

describe("first-time recipients", () => {
  it.each([
    ["a new admin", { type: "wasm/MsgUpdateAdmin", value: { sender: ME, new_admin: NEW_ADMIN, contract: CONTRACT } }, NEW_ADMIN],
    ["a withdraw address", { type: "cosmos-sdk/MsgModifyWithdrawAddress", value: { delegator_address: ME, withdraw_address: NEW_ADMIN } }, NEW_ADMIN],
    ["a position's new owner", { type: "osmosis/cl-transfer-positions", value: { sender: ME, position_ids: ["1"], new_owner: NEW_ADMIN } }, NEW_ADMIN],
    ["an instantiate's admin", { type: "wasm/MsgInstantiateContract", value: { sender: ME, admin: NEW_ADMIN, code_id: "1", label: "x", msg: {} } }, NEW_ADMIN],
    [
      "the one outside output of a multi-send",
      { type: "cosmos-sdk/MsgMultiSend", value: { inputs: [{ address: ME, coins: coins("5") }], outputs: [{ address: OUT_A, coins: coins("5") }] } },
      OUT_A,
    ],
  ])("warns of %s, and stops when it is known", async (_name, msg, recipient) => {
    expect((await sign([msg])).warnings).toContain(`First-time recipient: ${recipient}`);
    expect((await sign([msg], [recipient])).warnings).not.toContain(`First-time recipient: ${recipient}`);
  });

  it("names no single recipient for a multi-send with several outside outputs, and shows them all", async () => {
    const summary = await sign([
      {
        type: "cosmos-sdk/MsgMultiSend",
        value: { inputs: [{ address: ME, coins: coins("10") }], outputs: [{ address: OUT_A, coins: coins("5") }, { address: OUT_B, coins: coins("5") }] },
      },
    ]);
    expect(summary.warnings.filter((warning) => warning.startsWith("First-time recipient"))).toEqual([]);
    expect(summary.messages[0]?.detail).toMatchObject({
      kind: "multi-send",
      outputs: [{ address: OUT_A }, { address: OUT_B }],
    });
  });
});

describe("what the raw transaction shows of a contract message", () => {
  it("carries an instantiate's label, message, admin and funds, and a migration's message", async () => {
    const summary = await sign([
      { type: "wasm/MsgInstantiateContract", value: { sender: ME, admin: NEW_ADMIN, code_id: "9", label: "vault", msg: { owner: ME }, funds: coins("3") } },
      { type: "wasm/MsgMigrateContract", value: { sender: ME, contract: CONTRACT, code_id: "10", msg: { migrate: {} } } },
    ]);
    expect(summary.messages.map((message) => message.detail)).toEqual([
      { kind: "instantiate-contract", codeId: "9", label: "vault", admin: NEW_ADMIN, msg: { owner: ME }, funds: coins("3") },
      { kind: "migrate-contract", contract: CONTRACT, codeId: "10", msg: { migrate: {} } },
    ]);
  });
});

/** Signs with blind signing off or on, as the settings the worker reads. */
function signWith(blindSigning: boolean, msgs: Array<{ type: string; value: Record<string, unknown> }>) {
  vi.stubGlobal("browser", {
    storage: {
      local: {
        get: async (key: string) => (key === "zunia.settings" ? { [key]: { blindSigning } } : {}),
        set: async () => undefined,
      },
      onChanged: { addListener: () => undefined },
    },
  });
  return decodeAminoSignDoc("osmosis-1", {
    chain_id: "osmosis-1",
    account_number: "7",
    sequence: "3",
    memo: "",
    fee: { amount: [{ denom: "uosmo", amount: "5000" }], gas: "200000" },
    msgs,
  });
}

describe("messages nothing reads are gated, as in direct mode", () => {
  it.each([
    "cosmos-sdk/MsgGrant",
    "cosmos-sdk/MsgExec",
    "cosmos-sdk/MsgGrantAllowance",
    "wasm/MsgStoreCode",
    "cosmos-sdk/MsgSubmitProposal",
    "cosmos-sdk/v1/MsgSubmitProposal",
    "osmosis/smartaccount/add-authenticator",
    "osmosis/smartaccount/remove-authenticator",
    "osmosis/smartaccount/set-active-state",
  ])("%s needs the blind-signing opt-in", async (type) => {
    const off = await signWith(false, [{ type, value: { sender: ME } }]);
    expect(off.requiresBlindSigning).toBe(true);
    expect(off.messages[0]).toMatchObject({ summary: `Message ${type}`, unknown: true });
    const on = await signWith(true, [{ type, value: { sender: ME } }]);
    expect(on.requiresBlindSigning).toBe(false);
    expect(on.messages[0]?.unknown).toBe(true);
  });
});

describe("a dApp message refused for its shape is gated", () => {
  it.each([
    ["a multi-send that does not balance", "cosmos-sdk/MsgMultiSend", { inputs: [{ address: ME, coins: coins("5") }], outputs: [{ address: OUT_A, coins: coins("4") }] }],
    ["an instantiate whose message is not JSON", "wasm/MsgInstantiateContract", { sender: ME, code_id: "1", label: "x" }],
    ["a position in pool 0", "osmosis/cl-create-position", { pool_id: "0", sender: ME, lower_tick: "-1", upper_tick: "1", tokens_provided: coins("5"), token_min_amount0: "0", token_min_amount1: "0" }],
  ])("%s", async (_name, type, value) => {
    const off = await signWith(false, [{ type, value }]);
    expect(off.requiresBlindSigning).toBe(true);
    expect(off.messages[0]).toMatchObject({ summary: `Message ${type}`, unknown: true });
    expect((await signWith(true, [{ type, value }])).requiresBlindSigning).toBe(false);
  });

  it("leaves an unrecognised Msg type with its generic, ungated line", async () => {
    const summary = await signWith(false, [{ type: "some-chain/MsgDoThing", value: {} }]);
    expect(summary.requiresBlindSigning).toBe(false);
    expect(summary.messages[0]).toMatchObject({ summary: "Message some-chain/MsgDoThing", unknown: false });
  });
});
