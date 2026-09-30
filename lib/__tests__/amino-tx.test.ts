import { describe, expect, it } from "vitest";
import {
  assembleAminoTxRaw,
  estimateFee,
  makeStdSignDoc,
  msgSend,
  msgVote,
  pubkeyTypeUrl,
  signDocBytes,
} from "../amino-tx";

describe("amino-tx", () => {
  it("builds a MsgSend sign doc with sorted keys", () => {
    const fee = estimateFee({
      gasLimit: 200_000,
      gasPrice: 0.025,
      denom: "uatom",
    });
    expect(fee.amount[0]).toEqual({ denom: "uatom", amount: "5000" });

    const doc = makeStdSignDoc({
      chainId: "cosmoshub-4",
      accountNumber: "1",
      sequence: "2",
      fee,
      msgs: [
        msgSend({
          fromAddress: "cosmos1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqnrql8a",
          toAddress: "cosmos1qyqszqgpqyqszqgpqyqszqgpqyqszqgpjsrfrs",
          amount: [{ denom: "uatom", amount: "1000" }],
        }),
      ],
    });
    const bytes = signDocBytes(doc);
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith("{")).toBe(true);
    expect(text).toContain('"account_number":"1"');
    expect(text).toContain("cosmos-sdk/MsgSend");
  });

  it("assembles a TxRaw with 64-byte signature", () => {
    const fee = estimateFee({
      gasLimit: 200_000,
      gasPrice: 0.025,
      denom: "uatom",
    });
    const signDoc = makeStdSignDoc({
      chainId: "cosmoshub-4",
      accountNumber: "0",
      sequence: "0",
      fee,
      msgs: [
        msgVote({
          proposalId: "1",
          voter: "cosmos1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqnrql8a",
          option: "yes",
        }),
      ],
    });
    const pubKey = new Uint8Array(33);
    pubKey[0] = 2;
    const signature = new Uint8Array(64);
    const raw = assembleAminoTxRaw({ signDoc, pubKey, signature });
    expect(raw.length).toBeGreaterThan(64);
  });

  it("uses the chain pubkey type URL, and Ethermint when a chain does not set one", () => {
    const injective = "/injective.crypto.v1beta1.ethsecp256k1.PubKey";
    const ethermint = "/ethermint.crypto.v1.ethsecp256k1.PubKey";
    expect(pubkeyTypeUrl(true, injective)).toBe(injective);
    expect(pubkeyTypeUrl(true)).toBe(ethermint);
    expect(pubkeyTypeUrl(true, "  ")).toBe(ethermint);
    expect(pubkeyTypeUrl(false, injective)).toBe("/cosmos.crypto.secp256k1.PubKey");

    const fee = estimateFee({
      gasLimit: 200_000,
      gasPrice: 0.025,
      denom: "inj",
    });
    const signDoc = makeStdSignDoc({
      chainId: "injective-1",
      accountNumber: "0",
      sequence: "0",
      fee,
      msgs: [
        msgSend({
          fromAddress: "inj1n5sm83csgezypzlje2q9yc3dwagqnsp8f6x9nz",
          toAddress: "inj1n5sm83csgezypzlje2q9yc3dwagqnsp8f6x9nz",
          amount: [{ denom: "inj", amount: "1" }],
        }),
      ],
    });
    const pubKey = new Uint8Array(33);
    pubKey[0] = 2;
    const signature = new Uint8Array(64);
    const encoded = new TextDecoder().decode(
      assembleAminoTxRaw({
        signDoc,
        pubKey,
        signature,
        ethKeyType: true,
        ethPubKeyTypeUrl: injective,
      }),
    );
    expect(encoded).toContain(injective);
    expect(encoded).not.toContain(ethermint);
  });
});
