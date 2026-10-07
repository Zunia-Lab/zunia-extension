/**
 * A dApp's direct-mode requests, through the real wasm kernel the build ships
 * and the real adapter.
 *
 * - CosmWasm contracts and module accounts are 32-byte addresses. A swap, a
 *   swap recovery, an NFT transfer or a send to one must reach the prompt, not
 *   the blind-signing refusal they got from the zunia-core 11741e5 kernel in
 *   0.1.3 and 0.1.4.
 * - The prompt shows what a message carries beyond its sentence (kernel
 *   payload v2, zunia-core 0.1.1): a contract call's message and coins, a
 *   transfer's packet memo, an NFT's new owner.
 * - A message the kernel cannot read is refused by name.
 * - The Amino form of a message reads exactly as its direct bytes do
 *   (fixtures/amino-summaries.json, made by CosmJS and osmojs).
 * - What a site writes to mislead the prompt does not, in either mode:
 *   - padding never pushes a receiver out of the raw transaction, which is
 *     shown whole or refused;
 *   - a fee names every coin it pays;
 *   - a send_nft with a payload shaped like a bridge's names the contract
 *     that gets the NFT;
 *   - a token id or an address that hides text never reaches a sentence, or
 *     the recipients Zunia remembers.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { SIGNER } = vi.hoisted(() => ({ SIGNER: "osmo1qx8te2rzsdyj47q2hswzclqc52gp9nju8ltgjy" }));

vi.mock("../approval-ui", () => ({ approvalUiOpen: () => false, openApprovalUi: vi.fn(async () => undefined) }));

vi.mock("../kernel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../kernel")>();
  const { readFileSync } = await import("node:fs");
  const { createRequire } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  // ZUNIA_CORE_DIR: a freshly built packages/npm, before it is linked in.
  const dir = process.env.ZUNIA_CORE_DIR ?? dirname(createRequire(import.meta.url).resolve("@zunialab/core/package.json"));
  const core = (await import(/* @vite-ignore */ pathToFileURL(join(dir, "index.js")).href)) as typeof import("@zunialab/core");
  core.initZuniaCoreSync({ module: readFileSync(join(dir, "zunia_core_bg.wasm")) });
  const local = actual.createLocalKernel();
  const kernel = actual.adaptWasmKernel(
    core,
    {
      ...local,
      deriveAddress: () => ({ address: SIGNER, bech32Address: SIGNER, algo: "secp256k1", pubKey: new Uint8Array(33).fill(2) }),
      signCosmos: () => "11".repeat(64),
    },
    core.kernelVersion(),
  );
  return { ...actual, loadKernel: async () => kernel };
});

import { getPendingApprovals, resetApprovalsForTests, resolveApproval, type ApprovalRequest } from "../approvals";
import { handleProviderRequest } from "../provider-handler";
import { encodeDirectSignDoc } from "../provider-guards";
import { ProtoWriter, readProtoFields } from "../proto";
import { PACKET_MEMO_UNREADABLE } from "../packet-memo";
import { decodeAminoSignDoc, decodeDirectSignBytes, type SignSafetySummary } from "../signing";
import { STORAGE_KEYS } from "../storage-keys";
import fixture from "./fixtures/amino-summaries.json";

const ORIGIN = "https://app.example.com";
const CHAIN = "osmosis-1";
const XCS = "osmo1uwk8xc6q0s6t5qcpr6rht3sczu6du83xq8pwxjua0hfj5hzcnh3sqxwvxs";
/** A CW721 collection: 32 bytes, as wasmd derives every contract. */
const COLLECTION = "osmo19vxk34pf2uqf8warhsgqswa5sqyxnm493lxr4808gyy2rjs5yajq0c4l8v";
const NFT_RECIPIENT = "osmo1jrkmdcwgq94uaamx6zax2luewlhf7u4k5r4pqs";
const OUT = "ibc/794C7D7F3B857713878A3A1927251FA6AC1EEE520424C1F6FAFE9BA26D476138";
const PACKET_MEMO_NOTICE =
  "This transfer carries instructions for the receiving chain (packet memo). Check them under Raw transaction.";
/** The signer's own address on the Hub, where a site may claim to send something. */
const USER_ON_HUB = "cosmos1qx8te2rzsdyj47q2hswzclqc52gp9nju0yccyk";
/** Where a forged request really sends the funds. Shown, never checked: it lives on another chain. */
const ATTACKER_STRIDE = "stride1qx8te2rzsdyj47q2hswzclqc52gp9nju9dlkmh";
const ATTACKER_HUB = "cosmos1jrkmdcwgq94uaamx6zax2luewlhf7u4kucx3kz";

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

/** A wallet connected to this site on Osmosis and the Hub; returns its local storage. */
function installBrowser(): Map<string, unknown> {
  const now = Date.now();
  const local = new Map<string, unknown>([
    [
      STORAGE_KEYS.permissions,
      { [ORIGIN]: { origin: ORIGIN, chainIds: [CHAIN, "cosmoshub-4"], expiresAt: now + 60_000, createdAt: now, lastUsedAt: null, accounts: {} } },
    ],
    [STORAGE_KEYS.accounts, [{ index: 0, name: "Main", address: SIGNER, algo: "secp256k1", pubKeyHex: "02".repeat(33) }]],
  ]);
  vi.stubGlobal("browser", {
    storage: {
      local: area(local),
      session: area(new Map<string, unknown>([[STORAGE_KEYS.sessionMnemonic, "test words"], [STORAGE_KEYS.sessionActiveAccount, 0]])),
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    alarms: { create: vi.fn(async () => undefined), clear: vi.fn(async () => true) },
    tabs: { sendMessage: vi.fn(async () => undefined) },
  });
  return local;
}

const coin = (denom: string, amount: string) => new ProtoWriter().string(1, denom).string(2, amount).intoBytes();

interface WireDoc {
  bodyBytes: number[];
  authInfoBytes: number[];
  chainId: string;
  accountNumber: string;
}

/** A direct SignDoc holding one message, as CosmJS encodes it. */
function oneMessage(typeUrl: string, value: Uint8Array, chainId = CHAIN): WireDoc {
  const any = new ProtoWriter().string(1, typeUrl).bytes(2, value).intoBytes();
  const bodyBytes = new ProtoWriter().repeatedMessage(1, [any]).string(2, "Swap OSMO to ATOM · by Zunia-wallet").intoBytes();
  const fee = new ProtoWriter().repeatedMessage(1, [coin("uosmo", "5000")]).uint64(2, 250_000n).intoBytes();
  const authInfoBytes = new ProtoWriter().message(2, fee).intoBytes();
  encodeDirectSignDoc({ bodyBytes, authInfoBytes, chainId, accountNumber: 12345n }); // the same encoder the worker signs with
  return { bodyBytes: Array.from(bodyBytes), authInfoBytes: Array.from(authInfoBytes), chainId, accountNumber: "12345" };
}

/** A MsgExecuteContract from the signer. */
function contractCall(contract: string, msg: unknown, funds: Uint8Array[] = []): WireDoc {
  const execute = new ProtoWriter()
    .string(1, SIGNER)
    .string(2, contract)
    .bytes(3, new TextEncoder().encode(JSON.stringify(msg)))
    .repeatedMessage(5, funds)
    .intoBytes();
  return oneMessage("/cosmwasm.wasm.v1.MsgExecuteContract", execute);
}

const byName = (name: string) => {
  const found = fixture.cases.find((entry) => entry.name === name);
  if (!found) throw new Error(`fixture ${name} missing`);
  return found;
};

/** A reference SignDoc from the fixture, split the way a dApp hands it to signDirect. */
function referenceDoc(name: string): WireDoc {
  const fields = readProtoFields(Uint8Array.from(Buffer.from(byName(name).signDocHex, "hex")));
  const at = (field: number) => fields.find((entry) => entry.field === field);
  return {
    bodyBytes: Array.from(at(1)!.bytes!),
    authInfoBytes: Array.from(at(2)!.bytes!),
    chainId: new TextDecoder().decode(at(3)!.bytes!),
    accountNumber: String(at(4)!.varint),
  };
}

interface Prompt {
  approval: ApprovalRequest;
  summary: SignSafetySummary;
  /** The "Raw transaction" the prompt shows, as it shows it. */
  json: string;
  /** The direct-mode "Raw transaction", parsed. */
  raw: { fee: SignSafetySummary["fee"] | null; messages: Array<SignSafetySummary["messages"][number]> };
  /** Settles once the request is answered. */
  pending: Promise<unknown>;
}

/** An Amino sign doc as a dApp hands it to signAmino. */
interface AminoDoc {
  chain_id: string;
  account_number: string;
  sequence: string;
  fee: unknown;
  memo: string;
  msgs: Array<{ type: string; value: Record<string, unknown> }>;
}

function aminoDoc(
  msgs: AminoDoc["msgs"],
  fee: unknown = { amount: [{ denom: "uosmo", amount: "5000" }], gas: "200000" },
): AminoDoc {
  return { chain_id: CHAIN, account_number: "12345", sequence: "7", fee, memo: "", msgs };
}

/** Ask for a direct signature: the prompt it opens, or the refusal it got instead. */
function ask(doc: WireDoc): Promise<Prompt | string> {
  return request("signDirect", doc.chainId, doc);
}

/** Ask for an Amino signature, the same way. */
function askAmino(doc: AminoDoc): Promise<Prompt | string> {
  return request("signAmino", doc.chain_id, doc);
}

async function request(method: "signDirect" | "signAmino", chainId: string, doc: unknown): Promise<Prompt | string> {
  const pending = handleProviderRequest({ origin: ORIGIN, method, args: [chainId, SIGNER, doc] });
  const outcome = await Promise.race([
    pending.then(
      () => "resolved",
      (error: { code?: string; message?: string }) => `refused ${error.code}: ${error.message}`,
    ),
    vi
      .waitFor(() => expect(getPendingApprovals()).toHaveLength(1))
      .then(
        () => "prompt",
        () => "no prompt",
      ),
  ]);
  if (outcome !== "prompt") return outcome;
  const approval = getPendingApprovals()[0]!;
  const detail = approval.detail as { summary: SignSafetySummary; json: string };
  return { approval, summary: detail.summary, json: detail.json, raw: JSON.parse(detail.json) as Prompt["raw"], pending };
}

async function prompted(doc: WireDoc): Promise<Prompt> {
  const outcome = await ask(doc);
  if (typeof outcome === "string") throw new Error(`expected a prompt, got ${outcome}`);
  return outcome;
}

async function promptedAmino(doc: AminoDoc): Promise<Prompt> {
  const outcome = await askAmino(doc);
  if (typeof outcome === "string") throw new Error(`expected a prompt, got ${outcome}`);
  return outcome;
}

/** Approve the prompt and wait for the signature. */
async function approve(prompt: Prompt): Promise<void> {
  resolveApproval(prompt.approval.id, { approved: true });
  await prompt.pending;
}

/** A MsgTransfer from the signer, over channel-0 to `receiver`, carrying `memo`. */
function transferMessage(receiver: string, memo: string): Uint8Array {
  return new ProtoWriter()
    .string(1, "transfer")
    .string(2, "channel-0")
    .message(3, coin("uosmo", "250000000"))
    .string(4, SIGNER)
    .string(5, receiver)
    .uint64(7, 1_900_000_000_000_000_000n)
    .string(8, memo)
    .intoBytes();
}

/** The same transfer in Amino. */
function aminoTransfer(receiver: string, memo: string): AminoDoc["msgs"][number] {
  return {
    type: "cosmos-sdk/MsgTransfer",
    value: {
      memo,
      receiver,
      sender: SIGNER,
      source_channel: "channel-0",
      source_port: "transfer",
      timeout_height: {},
      timeout_timestamp: "1900000000000000000",
      token: { amount: "250000000", denom: "uosmo" },
    },
  };
}

/** A direct SignDoc holding these messages, with a fee in these coins. */
function messagesDoc(anys: Array<[typeUrl: string, value: Uint8Array]>, feeCoins = [coin("uosmo", "5000")], gas = 250_000n): WireDoc {
  const bodyBytes = new ProtoWriter()
    .repeatedMessage(
      1,
      anys.map(([typeUrl, value]) => new ProtoWriter().string(1, typeUrl).bytes(2, value).intoBytes()),
    )
    .intoBytes();
  const fee = new ProtoWriter().repeatedMessage(1, feeCoins).uint64(2, gas).intoBytes();
  const authInfoBytes = new ProtoWriter().message(2, fee).intoBytes();
  return { bodyBytes: Array.from(bodyBytes), authInfoBytes: Array.from(authInfoBytes), chainId: CHAIN, accountNumber: "12345" };
}

afterEach(() => {
  resetApprovalsForTests();
  vi.unstubAllGlobals();
});

describe("direct-mode contract calls on 32-byte contracts", () => {
  const swap = {
    osmosis_swap: {
      output_denom: "uatom",
      slippage: { twap: { window_seconds: 10, slippage_percentage: "5" } },
      receiver: "cosmos1qx8te2rzsdyj47q2hswzclqc52gp9nju0yccyk",
      on_failed_delivery: { local_recovery_addr: SIGNER },
    },
  };

  it("the XCS swap reaches the prompt, with its message and coins in the raw transaction", async () => {
    installBrowser();
    const { summary, raw } = await prompted(contractCall(XCS, swap, [coin("uosmo", "1000000")]));
    expect(summary.messages[0]).toMatchObject({
      type: "/cosmwasm.wasm.v1.MsgExecuteContract",
      summary: `Execute "osmosis_swap" on ${XCS} sending 1000000 uosmo`,
    });
    expect(summary.messages[0]!.unknown).toBeFalsy();
    expect(raw.messages[0]!.detail).toEqual({ kind: "execute-contract", contract: XCS, msg: swap, funds: [{ denom: "uosmo", amount: "1000000" }] });
    // The fee the document pays, which a 0.1.0 kernel never handed over.
    expect(summary.fees).toEqual([
      { label: "Fee", value: "0.005 OSMO" },
      { label: "Gas", value: "250,000" },
    ]);
  });

  it("a swap recovery reaches the prompt", async () => {
    installBrowser();
    const { summary, raw } = await prompted(contractCall(XCS, { recover: {} }));
    expect(summary.messages.map((message) => message.summary)).toEqual([`Execute "recover" on ${XCS}`]);
    expect(raw.messages[0]!.detail).toEqual({ kind: "execute-contract", contract: XCS, msg: { recover: {} }, funds: [] });
  });

  it("an NFT transfer reads as a gift of that token to its new owner, a first-time recipient", async () => {
    installBrowser();
    const { summary } = await prompted(contractCall(COLLECTION, { transfer_nft: { recipient: NFT_RECIPIENT, token_id: "rock & roll" } }));
    expect(summary.messages[0]).toMatchObject({
      summary: `Give away NFT rock & roll from collection ${COLLECTION} to ${NFT_RECIPIENT}`,
      recipient: NFT_RECIPIENT,
    });
    expect(summary.warnings).toContain(`First-time recipient: ${NFT_RECIPIENT}`);
  });

  it("names coins sent with an NFT transfer, which takes none, and warns", async () => {
    installBrowser();
    const { summary } = await prompted(contractCall(COLLECTION, { transfer_nft: { recipient: NFT_RECIPIENT, token_id: "1" } }, [coin("uosmo", "7")]));
    expect(summary.messages[0]!.summary).toBe(`Give away NFT 1 from collection ${COLLECTION} to ${NFT_RECIPIENT} sending 7 uosmo`);
    expect(summary.warnings).toContain("This message also sends coins. A CW721 transfer takes none, so check what you are approving.");
  });

  it("remembers each recipient once the user approves, so the next payment is not first-time", async () => {
    const local = installBrowser();
    const doc = contractCall(COLLECTION, { transfer_nft: { recipient: NFT_RECIPIENT, token_id: "1" } });
    const first = await prompted(doc);
    resolveApproval(first.approval.id, { approved: true });
    await first.pending;
    expect(local.get(STORAGE_KEYS.knownRecipients)).toEqual([NFT_RECIPIENT]);
    const second = await prompted(doc);
    expect(second.summary.warnings).not.toContain(`First-time recipient: ${NFT_RECIPIENT}`);
  });
});

describe("other direct-mode messages the 0.1.1 kernel reads", () => {
  it("a send to a 32-byte address reaches the prompt", async () => {
    installBrowser();
    const { summary } = await prompted(referenceDoc("send_to_32_byte"));
    const to = "cosmos1uwk8xc6q0s6t5qcpr6rht3sczu6du83xq8pwxjua0hfj5hzcnh3s4mk53k";
    expect(summary.messages).toEqual([{ type: "/cosmos.bank.v1beta1.MsgSend", summary: `Send 1000000 uatom to ${to}`, recipient: to }]);
    expect(summary.warnings).toContain(`First-time recipient: ${to}`);
  });

  it.each([
    ["swap_exact_out", `Swap at most 10000000 uosmo for exactly 340000 ${OUT} through pool 3586`],
    ["swap_exact_out_two_hops", `Swap at most 10000000 uosmo for exactly 340000 ${OUT} through pools 1 → 3586`],
    ["split_out", `Swap at most 10000000 uosmo for exactly 340000 ${OUT} through 2 routes (pools 3498; 3586)`],
  ])("an exact-out swap (%s) names its ceiling first", async (name, sentence) => {
    installBrowser();
    const { summary } = await prompted(referenceDoc(name));
    expect(summary.messages.map((message) => message.summary)).toEqual([sentence]);
    expect(summary.requiresBlindSigning).toBe(false);
  });

  it("an IBC transfer with a packet memo says so, and shows the memo in the raw transaction", async () => {
    installBrowser();
    const { summary, raw } = await prompted(referenceDoc("transfer_packet_forward_memo"));
    const memo = byName("transfer_packet_forward_memo").amino.value.memo;
    expect(summary.messages[0]!.summary).toBe("IBC transfer 1000000 uatom to osmo19rl4cm2hmr8afy4kldpxz3fka4jguq0a5m7df8 over channel-141");
    expect(summary.warnings).toContain(PACKET_MEMO_NOTICE);
    expect(raw.messages[0]!.detail).toEqual({
      kind: "ibc-transfer",
      sourceChannel: "channel-141",
      receiver: "osmo19rl4cm2hmr8afy4kldpxz3fka4jguq0a5m7df8",
      token: { denom: "uatom", amount: "1000000" },
      memo,
    });
  });

  it("an IBC transfer without one does not", async () => {
    installBrowser();
    const { summary } = await prompted(referenceDoc("transfer_timestamp_only"));
    expect(summary.warnings).not.toContain(PACKET_MEMO_NOTICE);
  });
});

describe("a message the kernel cannot read", () => {
  it("is refused before any prompt, by name", async () => {
    installBrowser();
    const grant = new ProtoWriter().string(1, SIGNER).string(2, NFT_RECIPIENT).intoBytes();
    const outcome = await ask(oneMessage("/cosmos.authz.v1beta1.MsgGrant", grant));
    expect(outcome).toBe("refused UNSUPPORTED: Blind signing disabled for unknown messages: /cosmos.authz.v1beta1.MsgGrant");
    expect(getPendingApprovals()).toEqual([]);
  });
});

describe("both sign modes read the same", () => {
  /** What the prompt shows, less the type label, which names the encoding. */
  const shown = (summary: SignSafetySummary) => ({
    messages: summary.messages.map(({ type: _type, ...rest }) => rest),
    warnings: summary.warnings,
    fees: summary.fees,
    memo: summary.memo,
    requiresBlindSigning: summary.requiresBlindSigning,
  });

  it.each(fixture.cases.map((entry) => [entry.name, entry] as const))("%s", async (_name, entry) => {
    installBrowser();
    const aminoDoc = {
      chain_id: entry.chainId,
      account_number: "12345",
      sequence: "7",
      fee: { amount: [{ denom: entry.chainId === CHAIN ? "uosmo" : "uatom", amount: "5000" }], gas: "200000" },
      memo: "",
      msgs: [entry.amino],
    };
    const amino = await decodeAminoSignDoc(entry.chainId, aminoDoc);
    const direct = await decodeDirectSignBytes(entry.chainId, Uint8Array.from(Buffer.from(entry.signDocHex, "hex")));
    expect(direct.messages[0]!.unknown).toBeFalsy();
    expect(shown(amino)).toEqual(shown(direct));
  });
});

describe("the raw transaction is shown whole, never cut", () => {
  /** Valid JSON for encoding/json, within ICS20's 32,768-byte memo limit: whitespace before the receiver. */
  const paddedForward = `{"forward":{${" ".repeat(12_500)}"receiver":"${ATTACKER_STRIDE}","port":"transfer","channel":"channel-5"}}`;
  const forwardNote = `The packet memo forwards the tokens from the receiving chain over channel-5 to ${ATTACKER_STRIDE}.`;

  it("direct: a transfer's packet-forward receiver behind 12k of padding, named beside the notice", async () => {
    installBrowser();
    const { summary, json } = await prompted(messagesDoc([["/ibc.applications.transfer.v1.MsgTransfer", transferMessage(USER_ON_HUB, paddedForward)]]));
    expect(summary.messages[0]!.summary).toBe(`IBC transfer 250000000 uosmo to ${USER_ON_HUB} over channel-0`);
    expect(json).toContain(ATTACKER_STRIDE);
    expect(json).not.toContain("[truncated]");
    expect(summary.warnings).toEqual(expect.arrayContaining([PACKET_MEMO_NOTICE, forwardNote]));
  });

  it("amino: the same transfer, its receiver in the raw transaction and named", async () => {
    installBrowser();
    const { summary, json } = await promptedAmino(aminoDoc([aminoTransfer(USER_ON_HUB, paddedForward)]));
    expect(summary.messages[0]!.summary).toBe(`IBC transfer 250000000 uosmo to ${USER_ON_HUB} over channel-0`);
    expect(json).toContain(ATTACKER_STRIDE);
    expect(summary.warnings).toEqual(expect.arrayContaining([PACKET_MEMO_NOTICE, forwardNote]));
  });

  it("direct: a swap's receiver written after a 12k next_memo", async () => {
    installBrowser();
    const msg = {
      osmosis_swap: {
        output_denom: "uatom",
        slippage: { twap: { window_seconds: 10, slippage_percentage: "5" } },
        next_memo: { note: "x".repeat(12_500) },
        receiver: ATTACKER_HUB,
        on_failed_delivery: "do_nothing",
      },
    };
    const { summary, json } = await prompted(contractCall(XCS, msg, [coin("uosmo", "1000000000")]));
    expect(summary.messages[0]!.summary).toBe(`Execute "osmosis_swap" on ${XCS} sending 1000000000 uosmo`);
    expect(json).toContain(ATTACKER_HUB);
  });

  it("direct: a padded first message leaves the second one's detail in view", async () => {
    installBrowser();
    const padded = new ProtoWriter()
      .string(1, SIGNER)
      .string(2, XCS)
      .bytes(3, new TextEncoder().encode(JSON.stringify({ recover: { note: "y".repeat(12_500) } })))
      .intoBytes();
    const forward = `{"forward":{"receiver":"${ATTACKER_STRIDE}","port":"transfer","channel":"channel-5"}}`;
    const { summary, raw } = await prompted(
      messagesDoc([
        ["/cosmwasm.wasm.v1.MsgExecuteContract", padded],
        ["/ibc.applications.transfer.v1.MsgTransfer", transferMessage(USER_ON_HUB, forward)],
      ]),
    );
    expect(raw.messages[1]!.detail).toMatchObject({ kind: "ibc-transfer", memo: forward });
    expect(summary.warnings).toContain(forwardNote);
  });

  it("refuses, in both modes, a transaction too large to show whole rather than cut it", async () => {
    installBrowser();
    const refusal = "refused UNSUPPORTED: This transaction is too large to show in full";
    // Amino: a 4.3 MB memo.
    const huge = `{"forward":{${" ".repeat(4_300_000)}"receiver":"${ATTACKER_STRIDE}","port":"transfer","channel":"channel-5"}}`;
    expect(await askAmino(aminoDoc([aminoTransfer(USER_ON_HUB, huge)]))).toBe(refusal);
    // Direct: 60 KB of contract message, nested 100 deep, which the prompt's JSON spells out over
    // more than 4 MB.
    const deep = `{"x":${"[".repeat(100)}${Array(30_000).fill("0").join(",")}${"]".repeat(100)}}`;
    expect(await ask(contractCall(XCS, JSON.parse(deep)))).toBe(refusal);
    expect(getPendingApprovals()).toEqual([]);
  });

  it("does not name a forward the chain could read differently, and says so", async () => {
    installBrowser();
    // encoding/json matches "Receiver" to the receiver field too, and the last one wins.
    const twoWays = `{"forward":{"receiver":"${USER_ON_HUB}","port":"transfer","channel":"channel-5","Receiver":"${ATTACKER_STRIDE}"}}`;
    const { summary } = await prompted(messagesDoc([["/ibc.applications.transfer.v1.MsgTransfer", transferMessage(USER_ON_HUB, twoWays)]]));
    expect(summary.warnings).toEqual(expect.arrayContaining([PACKET_MEMO_NOTICE, PACKET_MEMO_UNREADABLE]));
    expect(summary.warnings.join(" ")).not.toContain("forwards the tokens");
  });
});

describe("a fee in several coins", () => {
  const TO = "osmo1jrkmdcwgq94uaamx6zax2luewlhf7u4k5r4pqs";
  const fees = [
    { label: "Fee", value: "0.000001 ION + 1000 OSMO" },
    { label: "Gas", value: "250,000" },
  ];

  it("direct: names every coin, and the raw transaction holds them", async () => {
    installBrowser();
    const send = new ProtoWriter().string(1, SIGNER).string(2, TO).repeatedMessage(3, [coin("uosmo", "1")]).intoBytes();
    const { summary, raw } = await prompted(
      messagesDoc([["/cosmos.bank.v1beta1.MsgSend", send]], [coin("uion", "1"), coin("uosmo", "1000000000")]),
    );
    expect(summary.fees).toEqual(fees);
    expect(raw.fee).toEqual({
      amount: [
        { denom: "uion", amount: "1" },
        { denom: "uosmo", amount: "1000000000" },
      ],
      gas: "250000",
    });
  });

  it("amino: names every coin, not the first", async () => {
    installBrowser();
    const fee = { amount: [{ denom: "uion", amount: "1" }, { denom: "uosmo", amount: "1000000000" }], gas: "250000" };
    const send = { type: "cosmos-sdk/MsgSend", value: { amount: [{ amount: "1", denom: "uosmo" }], from_address: SIGNER, to_address: TO } };
    const { summary } = await promptedAmino(aminoDoc([send], fee));
    expect(summary.fees).toEqual(fees);
    expect(summary.fee).toEqual({ amount: fee.amount, gas: "250000" });
  });

  it("amino: names no fee it cannot read as the chain would", async () => {
    installBrowser();
    const send = { type: "cosmos-sdk/MsgSend", value: { amount: [{ amount: "1", denom: "uosmo" }], from_address: SIGNER, to_address: TO } };
    for (const fee of [
      { amount: [{ denom: "uosmo", amount: "5000" }, { denom: "uosmo + 1000000000 uatom", amount: "1" }], gas: "200000" },
      { amount: [{ denom: "uosmo", amount: "5000" }], gas: "200000 plus 1,000 OSMO" },
      { amount: "5000uosmo", gas: "200000" },
    ]) {
      resetApprovalsForTests();
      const { summary } = await promptedAmino(aminoDoc([send], fee));
      expect(summary.fees).toEqual([{ label: "Fee", value: "Not specified" }]);
    }
  });
});

describe("a send_nft whose payload reads like a bridge's (ICS721)", () => {
  /** What a bridge would read: a receiver on the Hub and a channel. Any contract can be handed it. */
  const outgoing = (extra: Record<string, unknown> = {}) =>
    Buffer.from(JSON.stringify({ receiver: USER_ON_HUB, channel_id: "channel-1", ...extra })).toString("base64");
  const sendNft = (contract: string) => ({ send_nft: { contract, token_id: "4242", msg: outgoing() } });
  const handed = `Hand NFT 4242 from collection ${COLLECTION} to contract ${XCS}`;

  it("direct: names the contract that receives the NFT, a first-time recipient, and not where the payload says", async () => {
    installBrowser();
    const { summary } = await prompted(contractCall(COLLECTION, sendNft(XCS)));
    expect(summary.requiresBlindSigning).toBe(false);
    expect(summary.messages[0]).toMatchObject({ summary: handed, recipient: XCS });
    expect(summary.warnings).toContain(`First-time recipient: ${XCS}`);
    expect(JSON.stringify(summary.messages)).not.toContain("which says it bridges");
  });

  it("amino: the same sentence and the same warning", async () => {
    installBrowser();
    const doc = aminoDoc([
      { type: "wasm/MsgExecuteContract", value: { sender: SIGNER, contract: COLLECTION, msg: sendNft(XCS), funds: [] } },
    ]);
    const { summary } = await promptedAmino(doc);
    expect(summary.messages[0]).toMatchObject({ summary: handed, recipient: XCS });
    expect(summary.warnings).toContain(`First-time recipient: ${XCS}`);
  });

  it("says where it goes only for the bridge the user pinned for the chain, still naming the bridge", async () => {
    const local = installBrowser();
    local.set(STORAGE_KEYS.nftBridges, { [CHAIN]: XCS });
    const direct = await prompted(contractCall(COLLECTION, sendNft(XCS)));
    const bridged = `${handed}, which says it bridges it across channel-1 to ${USER_ON_HUB}`;
    expect(direct.summary.messages[0]).toMatchObject({ summary: bridged, recipient: XCS });
    expect(direct.summary.warnings).toContain(`First-time recipient: ${XCS}`);
    resetApprovalsForTests();
    const amino = await promptedAmino(
      aminoDoc([{ type: "wasm/MsgExecuteContract", value: { sender: SIGNER, contract: COLLECTION, msg: sendNft(XCS), funds: [] } }]),
    );
    expect(amino.summary.messages[0]).toMatchObject({ summary: bridged, recipient: XCS });
    // A bridge pinned on another chain is not this chain's.
    resetApprovalsForTests();
    local.set(STORAGE_KEYS.nftBridges, { "stargaze-1": XCS });
    expect((await prompted(contractCall(COLLECTION, sendNft(XCS)))).summary.messages[0]!.summary).toBe(handed);
  });

  it("keeps the receiving contract in the raw transaction when the payload is padded and written first", async () => {
    installBrowser();
    const body = { send_nft: { msg: outgoing({ memo: "z".repeat(9_500) }), token_id: "4242", contract: XCS } };
    const { summary, json } = await prompted(contractCall(COLLECTION, body));
    expect(summary.messages[0]!.summary).toBe(handed);
    expect(json).not.toContain("[truncated]");
    expect((JSON.parse(json) as Prompt["raw"]).messages[0]!.detail).toEqual({ kind: "execute-contract", contract: COLLECTION, msg: body, funds: [] });
  });

  it("remembers the contract once approved, as an address", async () => {
    const local = installBrowser();
    await approve(await prompted(contractCall(COLLECTION, sendNft(XCS))));
    expect(local.get(STORAGE_KEYS.knownRecipients)).toEqual([XCS]);
  });
});

describe("a token id or an address that hides text", () => {
  /** P2b: a bidi override and a NUL in the recipient, a line separator in the token id. */
  const disguised = { transfer_nft: { recipient: "osmo1friend\u202e\u0000 to osmo1legit", token_id: "1\u2028 from collection osmo1legit" } };

  it("direct: keeps the kernel's sentence, and remembers nothing once approved", async () => {
    const local = installBrowser();
    const prompt = await prompted(contractCall(COLLECTION, disguised));
    expect(prompt.summary.messages[0]).toEqual({ type: "/cosmwasm.wasm.v1.MsgExecuteContract", summary: `Execute "transfer_nft" on ${COLLECTION}`, detail: expect.anything() });
    await approve(prompt);
    expect(local.get(STORAGE_KEYS.knownRecipients)).toBeUndefined();
  });

  it.each([
    ["a token id with a line separator", { recipient: NFT_RECIPIENT, token_id: "1\u2028 from collection osmo1legit" }],
    ["a token id with a right-to-left override", { recipient: NFT_RECIPIENT, token_id: "\u202e1" }],
    ["a recipient that is not an address", { recipient: "osmo1friend", token_id: "1" }],
    ["a recipient on another chain", { recipient: USER_ON_HUB, token_id: "1" }],
  ])("direct and amino: %s keeps the generic sentence", async (_name, transfer) => {
    installBrowser();
    const direct = await prompted(contractCall(COLLECTION, { transfer_nft: transfer }));
    expect(direct.summary.messages[0]!.summary).toBe(`Execute "transfer_nft" on ${COLLECTION}`);
    expect(direct.summary.messages[0]!.recipient).toBeUndefined();
    resetApprovalsForTests();
    const amino = await promptedAmino(
      aminoDoc([{ type: "wasm/MsgExecuteContract", value: { sender: SIGNER, contract: COLLECTION, msg: { transfer_nft: transfer }, funds: [] } }]),
    );
    expect(amino.summary.messages[0]!.summary).toBe(`Execute "transfer_nft" on ${COLLECTION}`);
    expect(amino.summary.messages[0]!.recipient).toBeUndefined();
  });

  it("amino: a send's recipient that is not an address is never remembered, one that is, is", async () => {
    const local = installBrowser();
    const send = (to: string) => ({ type: "cosmos-sdk/MsgSend", value: { amount: [{ amount: "1", denom: "uosmo" }], from_address: SIGNER, to_address: to } });
    await approve(await promptedAmino(aminoDoc([send("osmo1friend\u202e\u0000 to osmo1legit")])));
    expect(local.get(STORAGE_KEYS.knownRecipients)).toBeUndefined();
    await approve(await promptedAmino(aminoDoc([send(NFT_RECIPIENT)])));
    expect(local.get(STORAGE_KEYS.knownRecipients)).toEqual([NFT_RECIPIENT]);
  });
});
