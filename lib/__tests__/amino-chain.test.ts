/**
 * Amino sign bytes are the bytes the chain rebuilds, or the signature is
 * refused as "unauthorized" after the user approved it.
 *
 * Two references, neither of them this code:
 * - fixtures/chain-verified-amino.json: real amino-signed cosmoshub-4
 *   transactions (copied from zunia-dashboard). For each, the on-chain
 *   secp256k1 signature verifies over `signBytesHex`, and this file checks
 *   that again with @noble/curves before trusting it.
 * - Golden strings from @cosmjs/amino 0.33.1 `serializeSignDoc` (what Keplr
 *   signs): sorted keys, and & < > written as \u0026 \u003c \u003e, as Go's
 *   encoding/json writes them when the chain rebuilds the document. Printed
 *   by this, run in zunia-core/tests/vectors/generate after `pnpm install`:
 *
 *     node -e 'const { makeSignDoc, serializeSignDoc } = require("@cosmjs/amino");
 *       const print = (msg, denom, chain, memo) => console.log(Buffer.from(serializeSignDoc(
 *         makeSignDoc([msg], { amount: [{ denom, amount: "5000" }], gas: "200000" }, chain, memo, "7", "3"))).toString());
 *       print({ type: "cosmos-sdk/MsgSend", value: { from_address: "cosmos1r69v2p02qm6sh5ppjrvurxz0vzyh23dvxyssvx",
 *         to_address: "cosmos1xv327r0e7ljwk0whqv6knctts57j6pn8fgsqry", amount: [{ denom: "uatom", amount: "1" }] } },
 *         "uatom", "cosmoshub-4", "rent & food <3>");
 *       print({ type: "wasm/MsgExecuteContract", value: { sender: "stars1qx8te2rzsdyj47q2hswzclqc52gp9nju6yfdwf",
 *         contract: "stars1collection", msg: { transfer_nft: { recipient: "stars1b", token_id: "rock & roll" } },
 *         funds: [] } }, "ustars", "stargaze-1", "");'
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";

import {
  assembleAminoTxRaw,
  makeStdSignDoc,
  msgIbcTransfer,
  msgSend,
  msgVote,
  signDocBytes,
  voteOptionNumber,
  type StdSignDoc,
  type VoteOption,
} from "../amino-tx";
import { adr36SignBytesHex, escapeAminoJson, serializeAminoSignDoc } from "../kernel";
import { readProtoFields } from "../proto";
import chain from "./fixtures/chain-verified-amino.json";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const fromHex = (value: string) => Uint8Array.from(Buffer.from(value, "hex"));
const fromB64 = (value: string) => Uint8Array.from(Buffer.from(value, "base64"));

type Case = (typeof chain.cases)[number];
const byName = (name: string): Case => {
  const found = chain.cases.find((c) => c.name === name);
  if (!found) throw new Error(`fixture ${name} missing`);
  return found;
};
/** The fixture's own document, parsed back out of the bytes the chain verified. */
const docOf = (c: Case) => JSON.parse(text(fromHex(c.signBytesHex))) as StdSignDoc & {
  msgs: Array<{ type: string; value: Record<string, unknown> }>;
};
const chainVerifies = (c: Case, bytes: Uint8Array) =>
  secp256k1.verify(fromB64(c.signature), sha256(bytes), fromB64(c.pubKey), { prehash: false, lowS: false });

describe("the chain fixture", () => {
  it.each(chain.cases.map((c) => [c.name, c] as const))("%s: the on-chain signature verifies over its bytes", (_name, c) => {
    expect(chainVerifies(c, fromHex(c.signBytesHex))).toBe(true);
  });
});

describe("governance vote", () => {
  const OPTIONS: Record<number, VoteOption> = { 1: "yes", 2: "abstain", 3: "no", 4: "veto" };

  it.each(["vote_yes", "vote_no"])("%s: msgVote signs the bytes cosmoshub-4 verified", (name) => {
    const c = byName(name);
    const doc = docOf(c);
    const value = doc.msgs[0]!.value;
    const ours = signDocBytes(
      makeStdSignDoc({
        chainId: doc.chain_id,
        accountNumber: doc.account_number,
        sequence: doc.sequence,
        fee: doc.fee,
        memo: doc.memo,
        msgs: [msgVote({ proposalId: String(value.proposal_id), voter: String(value.voter), option: OPTIONS[value.option as number]! })],
      }),
    );
    expect(hex(ours)).toBe(c.signBytesHex);
    expect(chainVerifies(c, ours)).toBe(true);
  });

  it("broadcasts the option it signed", () => {
    const doc = makeStdSignDoc({
      chainId: "cosmoshub-4",
      accountNumber: "1",
      sequence: "0",
      fee: { amount: [{ denom: "uatom", amount: "886" }], gas: "147546" },
      msgs: [msgVote({ proposalId: "1058", voter: "cosmos1xv327r0e7ljwk0whqv6knctts57j6pn8fgsqry", option: "veto" })],
    });
    expect(text(signDocBytes(doc))).toContain('"option":4');
    const raw = assembleAminoTxRaw({ signDoc: doc, pubKey: Uint8Array.from([2, ...new Uint8Array(32)]), signature: new Uint8Array(64) });
    const body = readProtoFields(raw).find((f) => f.field === 1)!.bytes!;
    const any = readProtoFields(body).find((f) => f.field === 1)!.bytes!;
    const vote = readProtoFields(readProtoFields(any).find((f) => f.field === 2)!.bytes!);
    expect(vote.find((f) => f.field === 3)?.varint).toBe(4n);
  });

  it("reads the option as a number or an enum name, and never signs an empty one", () => {
    expect(voteOptionNumber(1)).toBe(1);
    expect(voteOptionNumber("VOTE_OPTION_NO_WITH_VETO")).toBe(4);
    expect(voteOptionNumber(0)).toBe(0);
    expect(voteOptionNumber("yes")).toBe(0);
    const doc = makeStdSignDoc({
      chainId: "cosmoshub-4",
      accountNumber: "1",
      sequence: "0",
      fee: { amount: [], gas: "1" },
      msgs: [{ type: "cosmos-sdk/MsgVote", value: { proposal_id: "1", voter: "cosmos1x", option: 0 } }],
    });
    expect(() => assembleAminoTxRaw({ signDoc: doc, pubKey: new Uint8Array(33), signature: new Uint8Array(64) })).toThrow(/option/);
  });
});

describe("IBC transfer with a timestamp and no height", () => {
  it.each(["transfer_timestamp_only_no_memo", "transfer_timestamp_only_with_memo"])(
    "%s: msgIbcTransfer signs the bytes cosmoshub-4 verified",
    (name) => {
      const c = byName(name);
      const doc = docOf(c);
      const v = doc.msgs[0]!.value;
      const ours = signDocBytes(
        makeStdSignDoc({
          chainId: doc.chain_id,
          accountNumber: doc.account_number,
          sequence: doc.sequence,
          fee: doc.fee,
          memo: doc.memo,
          msgs: [
            msgIbcTransfer({
              sourcePort: String(v.source_port),
              sourceChannel: String(v.source_channel),
              token: v.token as { denom: string; amount: string },
              sender: String(v.sender),
              receiver: String(v.receiver),
              timeoutTimestamp: String(v.timeout_timestamp),
              ...(typeof v.memo === "string" ? { memo: v.memo } : {}),
            }),
          ],
        }),
      );
      expect(hex(ours)).toBe(c.signBytesHex);
      expect(chainVerifies(c, ours)).toBe(true);
    },
  );
});

describe("amino JSON escaping", () => {
  const A = "cosmos1r69v2p02qm6sh5ppjrvurxz0vzyh23dvxyssvx";
  const B = "cosmos1xv327r0e7ljwk0whqv6knctts57j6pn8fgsqry";

  it("writes & < > the way CosmJS serializeSignDoc and the chain do", () => {
    const doc = makeStdSignDoc({
      chainId: "cosmoshub-4",
      accountNumber: "7",
      sequence: "3",
      fee: { amount: [{ denom: "uatom", amount: "5000" }], gas: "200000" },
      memo: "rent & food <3>",
      msgs: [msgSend({ fromAddress: A, toAddress: B, amount: [{ denom: "uatom", amount: "1" }] })],
    });
    // @cosmjs/amino 0.33.1 serializeSignDoc of the same document (see the header).
    expect(text(serializeAminoSignDoc(doc))).toBe(
      '{"account_number":"7","chain_id":"cosmoshub-4","fee":{"amount":[{"amount":"5000","denom":"uatom"}],"gas":"200000"},"memo":"rent \\u0026 food \\u003c3\\u003e","msgs":[{"type":"cosmos-sdk/MsgSend","value":{"amount":[{"amount":"1","denom":"uatom"}],"from_address":"cosmos1r69v2p02qm6sh5ppjrvurxz0vzyh23dvxyssvx","to_address":"cosmos1xv327r0e7ljwk0whqv6knctts57j6pn8fgsqry"}}],"sequence":"3"}',
    );
  });

  it("escapes inside nested values a dApp sends (a contract message)", () => {
    const doc = {
      account_number: "7",
      chain_id: "stargaze-1",
      fee: { amount: [{ denom: "ustars", amount: "5000" }], gas: "200000" },
      memo: "",
      msgs: [
        {
          type: "wasm/MsgExecuteContract",
          value: {
            sender: "stars1qx8te2rzsdyj47q2hswzclqc52gp9nju6yfdwf",
            contract: "stars1collection",
            msg: { transfer_nft: { recipient: "stars1b", token_id: "rock & roll" } },
            funds: [],
          },
        },
      ],
      sequence: "3",
    };
    // @cosmjs/amino 0.33.1 serializeSignDoc of the same document (see the header).
    expect(text(serializeAminoSignDoc(doc))).toBe(
      '{"account_number":"7","chain_id":"stargaze-1","fee":{"amount":[{"amount":"5000","denom":"ustars"}],"gas":"200000"},"memo":"","msgs":[{"type":"wasm/MsgExecuteContract","value":{"contract":"stars1collection","funds":[],"msg":{"transfer_nft":{"recipient":"stars1b","token_id":"rock \\u0026 roll"}},"sender":"stars1qx8te2rzsdyj47q2hswzclqc52gp9nju6yfdwf"}}],"sequence":"3"}',
    );
  });

  it("escapes the line and paragraph separators Go escapes, and nothing else", () => {
    expect(escapeAminoJson(JSON.stringify({ memo: "a\u2028b\u2029c" }))).toBe('{"memo":"a\\u2028b\\u2029c"}');
    expect(escapeAminoJson(JSON.stringify({ memo: "plain · ünïcode \\u0026" }))).toBe(JSON.stringify({ memo: "plain · ünïcode \\u0026" }));
  });

  it("leaves ADR-36 sign bytes as they were (base64 data and bech32 never hold & < >)", () => {
    const bytes = text(fromHex(adr36SignBytesHex(A, new TextEncoder().encode("hello <world> & co"))));
    expect(bytes).toBe(
      `{"account_number":"0","chain_id":"","fee":{"amount":[],"gas":"0"},"memo":"","msgs":[{"type":"sign/MsgSignData","value":{"data":"${Buffer.from("hello <world> & co").toString("base64")}","signer":"${A}"}}],"sequence":"0"}`,
    );
  });
});
