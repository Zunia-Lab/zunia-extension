import { describe, expect, it } from "vitest";
import {
  assembleAminoTxRaw,
  estimateFee,
  makeStdSignDoc,
  msgSend,
  msgVote,
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
});
