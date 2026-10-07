/**
 * What a dApp's signAmino / signDirect request turns into: the exact bytes
 * handed to the key, and the refusal a site reads when Zunia cannot decode a
 * message.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { SIGNER, signed, decoded } = vi.hoisted(() => ({
  SIGNER: "cosmos1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu",
  /** signBytesHex of every signCosmos call. */
  signed: [] as string[],
  /** What the stub kernel's decodeDirectTx reports next. */
  decoded: {
    value: null as null | { chainId: string; accountNumber: string; messages: Array<{ typeUrl: string; summary: string; unknown?: boolean }> },
  },
}));

vi.mock("../approval-ui", () => ({ approvalUiOpen: () => false, openApprovalUi: vi.fn(async () => undefined) }));

vi.mock("../kernel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../kernel")>();
  return {
    ...actual,
    loadKernel: async () => ({
      deriveAddress: () => ({ address: SIGNER, bech32Address: SIGNER, algo: "secp256k1", pubKey: new Uint8Array(33).fill(2) }),
      signCosmos: (_p: string, _pp: string, _c: string, _i: number, signBytesHex: string) => {
        signed.push(signBytesHex);
        return "11".repeat(64);
      },
      decodeDirectTx: () => decoded.value,
    }),
  };
});

import { getPendingApprovals, resetApprovalsForTests, resolveApproval } from "../approvals";
import { handleProviderRequest, type ProviderMethod } from "../provider-handler";
import type { SignSafetySummary } from "../signing";
import { STORAGE_KEYS } from "../storage-keys";

const ORIGIN = "https://app.example.com";
const CHAIN = "cosmoshub-4";

function area(map: Map<string, unknown>) {
  return {
    get: async (keys?: string | string[] | null) => {
      const list = keys == null ? [...map.keys()] : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const key of list) if (map.has(key)) out[key] = map.get(key);
      return out;
    },
    set: async (patch: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(patch)) map.set(key, value);
    },
    remove: async (keys: string | string[]) => {
      for (const key of [keys].flat()) map.delete(key);
    },
  };
}

function installBrowser(): void {
  const now = Date.now();
  const local = new Map<string, unknown>([
    [
      STORAGE_KEYS.permissions,
      { [ORIGIN]: { origin: ORIGIN, chainIds: [CHAIN, "osmosis-1"], expiresAt: now + 60_000, createdAt: now, lastUsedAt: null, accounts: {} } },
    ],
    [STORAGE_KEYS.accounts, [{ index: 0, name: "Main", address: SIGNER, algo: "secp256k1", pubKeyHex: "02".repeat(33) }]],
  ]);
  const session = new Map<string, unknown>([
    [STORAGE_KEYS.sessionMnemonic, "test words"],
    [STORAGE_KEYS.sessionActiveAccount, 0],
  ]);
  vi.stubGlobal("browser", {
    storage: { local: area(local), session: area(session), onChanged: { addListener: vi.fn(), removeListener: vi.fn() } },
    alarms: { create: vi.fn(async () => undefined), clear: vi.fn(async () => true) },
    tabs: { sendMessage: vi.fn(async () => undefined) },
  });
}

const call = (method: ProviderMethod, args: unknown[]) => handleProviderRequest({ origin: ORIGIN, method, args });

afterEach(() => {
  resetApprovalsForTests();
  signed.length = 0;
  decoded.value = null;
  vi.unstubAllGlobals();
});

describe("signAmino", () => {
  it("signs a memo holding & < > as CosmJS and the chain serialize it", async () => {
    installBrowser();
    const doc = {
      chain_id: CHAIN,
      account_number: "7",
      sequence: "3",
      fee: { amount: [{ denom: "uatom", amount: "5000" }], gas: "200000" },
      memo: "rent & food <3>",
      msgs: [{ type: "cosmos-sdk/MsgSend", value: { from_address: SIGNER, to_address: SIGNER, amount: [{ denom: "uatom", amount: "1" }] } }],
    };
    const pending = call("signAmino", [CHAIN, SIGNER, doc]);
    await vi.waitFor(() => expect(getPendingApprovals()).toHaveLength(1));
    resolveApproval(getPendingApprovals()[0]!.id, { approved: true });
    const response = (await pending) as { signed: typeof doc };
    expect(response.signed.memo).toBe("rent & food <3>");
    const bytes = Buffer.from(signed[0]!, "hex").toString("utf8");
    expect(bytes).toContain('"memo":"rent \\u0026 food \\u003c3\\u003e"');
    expect(bytes).not.toMatch(/[&<>]/);
  });
});

describe("signDirect refused for an undecodable message", () => {
  it("names the type it could not read, after the sentence sites match on", async () => {
    installBrowser();
    decoded.value = {
      chainId: CHAIN,
      accountNumber: "0",
      messages: [
        {
          typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
          summary: "UNKNOWN ACTION: /cosmwasm.wasm.v1.MsgExecuteContract (126 bytes the wallet cannot read)",
          unknown: true,
        },
      ],
    };
    const doc = { bodyBytes: [10, 0], authInfoBytes: [], chainId: CHAIN, accountNumber: "1" };
    await expect(call("signDirect", [CHAIN, SIGNER, doc])).rejects.toMatchObject({
      code: "UNSUPPORTED",
      message: "Blind signing disabled for unknown messages: /cosmwasm.wasm.v1.MsgExecuteContract",
    });
    expect(getPendingApprovals()).toEqual([]);
    expect(signed).toEqual([]);
  });

  it("keeps the bare sentence when the kernel names no type", async () => {
    installBrowser();
    decoded.value = { chainId: CHAIN, accountNumber: "0", messages: [{ typeUrl: "", summary: "Swap …", unknown: true }] };
    const doc = { bodyBytes: [10, 0], authInfoBytes: [], chainId: CHAIN, accountNumber: "1" };
    await expect(call("signDirect", [CHAIN, SIGNER, doc])).rejects.toMatchObject({
      code: "UNSUPPORTED",
      message: "Blind signing disabled for unknown messages",
    });
  });
});

describe("signAmino in the kernel's words", () => {
  const OSMO = "osmo19rl4cm2hmr8afy4kldpxz3fka4jguq0a5m7df8";
  const ATOM = "ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2";
  const swap = {
    type: "osmosis/poolmanager/swap-exact-amount-in",
    value: { sender: OSMO, routes: [{ pool_id: "1", token_out_denom: ATOM }], token_in: { denom: "uosmo", amount: "1000" }, token_out_min_amount: "1" },
  };
  const doc = (chainId: string, msg: { type: string; value: Record<string, unknown> }) => ({
    chain_id: chainId,
    account_number: "7",
    sequence: "3",
    fee: { amount: [{ denom: chainId === CHAIN ? "uatom" : "uosmo", amount: "5000" }], gas: "200000" },
    memo: "",
    msgs: [msg],
  });
  const prompt = async (chainId: string, msg: { type: string; value: Record<string, unknown> }) => {
    void call("signAmino", [chainId, SIGNER, doc(chainId, msg)]).catch(() => undefined);
    await vi.waitFor(() => expect(getPendingApprovals()).toHaveLength(1));
    return (getPendingApprovals()[0]!.detail as { summary: SignSafetySummary }).summary;
  };

  it("reaches the prompt for an Osmosis pool swap, which 0.1.4 refused for having no Msg in its type", async () => {
    installBrowser();
    const summary = await prompt("osmosis-1", swap);
    expect(summary.messages).toEqual([{ type: swap.type, summary: `Swap 1000 uosmo for at least 1 ${ATOM} through pool 1` }]);
    expect(summary.requiresBlindSigning).toBe(false);
  });

  it("still refuses one the chain could not rebuild, and names it", async () => {
    installBrowser();
    const floorless = { ...swap, value: { ...swap.value, token_out_min_amount: "0" } };
    await expect(call("signAmino", ["osmosis-1", SIGNER, doc("osmosis-1", floorless)])).rejects.toMatchObject({
      code: "UNSUPPORTED",
      message: "Blind signing disabled for unknown messages: osmosis/poolmanager/swap-exact-amount-in",
    });
    expect(signed).toEqual([]);
  });

  it("names a vote's choice, and refuses an option outside the enum by name", async () => {
    installBrowser();
    const vote = (option: unknown) => ({ type: "cosmos-sdk/MsgVote", value: { proposal_id: "848", voter: "cosmos19rl4cm2hmr8afy4kldpxz3fka4jguq0auqdal4", option } });
    expect((await prompt(CHAIN, vote(4))).messages[0]!.summary).toBe("Vote No with veto on proposal 848");
    resetApprovalsForTests();
    await expect(call("signAmino", [CHAIN, SIGNER, doc(CHAIN, vote("VOTE_OPTION_UNSPECIFIED"))])).rejects.toMatchObject({
      code: "UNSUPPORTED",
      message: "Blind signing disabled for unknown messages: cosmos-sdk/MsgVote",
    });
  });

  it("says when a transfer carries a packet memo", async () => {
    installBrowser();
    const transfer = {
      type: "cosmos-sdk/MsgTransfer",
      value: {
        source_port: "transfer",
        source_channel: "channel-141",
        token: { denom: "uatom", amount: "1" },
        sender: "cosmos19rl4cm2hmr8afy4kldpxz3fka4jguq0auqdal4",
        receiver: OSMO,
        timeout_height: {},
        timeout_timestamp: "1791400000000000000",
        memo: JSON.stringify({ forward: { receiver: "stride1x", port: "transfer", channel: "channel-5" } }),
      },
    };
    const summary = await prompt(CHAIN, transfer);
    expect(summary.messages[0]).toMatchObject({ summary: `IBC transfer 1 uatom to ${OSMO} over channel-141`, recipient: OSMO });
    expect(summary.warnings).toContain(
      "This transfer carries instructions for the receiving chain (packet memo). Check them under Raw transaction.",
    );
  });
});
