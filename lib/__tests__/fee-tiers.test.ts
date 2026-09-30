import { describe, expect, it } from "vitest";

import {
  aminoFeeOf,
  authInfoFee,
  feeChoiceFor,
  signOptionsFrom,
  withAminoFee,
  withAuthInfoFee,
} from "../fee-tiers";
import { ProtoWriter, readProtoFields } from "../proto";

const ALLOWED = { preferNoSetFee: false };

describe("feeChoiceFor", () => {
  it("prices each tier from the catalog, rounding up", () => {
    const choice = feeChoiceFor(
      "cosmoshub-4",
      { amount: [{ denom: "uatom", amount: "4000" }], gas: "123457" },
      ALLOWED,
    );
    expect(choice).toEqual({
      denom: "uatom",
      symbol: "ATOM.cosmos",
      decimals: 6,
      gas: "123457",
      site: "4000",
      tiers: { low: "618", average: "3087", high: "3704" },
    });
  });

  it("offers nothing when the site asked to keep its fee", () => {
    const fee = { amount: [{ denom: "uatom", amount: "4000" }], gas: "200000" };
    expect(feeChoiceFor("cosmoshub-4", fee, { preferNoSetFee: true })).toBeNull();
  });

  it("offers nothing for a fee it cannot price", () => {
    const gas = "200000";
    expect(feeChoiceFor("cosmoshub-4", { amount: [{ denom: "ibc/ABC", amount: "1" }], gas }, ALLOWED)).toBeNull();
    expect(
      feeChoiceFor(
        "cosmoshub-4",
        {
          amount: [
            { denom: "uatom", amount: "1" },
            { denom: "uatom", amount: "2" },
          ],
          gas,
        },
        ALLOWED,
      ),
    ).toBeNull();
    expect(feeChoiceFor("cosmoshub-4", { amount: [], gas }, ALLOWED)).toBeNull();
    expect(feeChoiceFor("cosmoshub-4", { amount: [{ denom: "uatom", amount: "1" }], gas: "0" }, ALLOWED)).toBeNull();
    expect(feeChoiceFor("not-a-chain", { amount: [{ denom: "uatom", amount: "1" }], gas }, ALLOWED)).toBeNull();
  });
});

describe("signOptionsFrom", () => {
  it("only honours an explicit true", () => {
    expect(signOptionsFrom({ preferNoSetFee: true })).toEqual({ preferNoSetFee: true });
    expect(signOptionsFrom({ preferNoSetFee: "yes" })).toEqual({ preferNoSetFee: false });
    expect(signOptionsFrom(undefined)).toEqual({ preferNoSetFee: false });
  });
});

describe("amino fees", () => {
  const doc = {
    chain_id: "cosmoshub-4",
    fee: { amount: [{ denom: "uatom", amount: "4000" }], gas: "200000", granter: "cosmos1granter" },
    msgs: [],
    memo: "",
  };

  it("reads the fee and replaces only its coins", () => {
    expect(aminoFeeOf(doc)).toEqual({ amount: [{ denom: "uatom", amount: "4000" }], gas: "200000" });
    const signed = withAminoFee(doc, { denom: "uatom", amount: "6000" });
    expect(signed.fee).toEqual({
      amount: [{ denom: "uatom", amount: "6000" }],
      gas: "200000",
      granter: "cosmos1granter",
    });
    expect(doc.fee.amount[0]?.amount).toBe("4000");
  });

  it("refuses a fee with malformed coins", () => {
    expect(aminoFeeOf({ fee: { amount: [{ denom: "uatom" }], gas: "1" } })).toBeNull();
    expect(aminoFeeOf({})).toBeNull();
  });
});

describe("direct fees", () => {
  const coin = (denom: string, amount: string) =>
    new ProtoWriter().string(1, denom).string(2, amount).intoBytes();
  const signerInfo = new ProtoWriter().bytes(1, Uint8Array.from([1, 2, 3])).uint64(3, 9n).intoBytes();
  const fee = new ProtoWriter()
    .repeatedMessage(1, [coin("uatom", "4000")])
    .uint64(2, 200000n)
    .string(4, "cosmos1granter")
    .intoBytes();
  const tip = new ProtoWriter().string(2, "cosmos1tipper").intoBytes();
  const authInfo = new ProtoWriter()
    .repeatedMessage(1, [signerInfo])
    .message(2, fee)
    .message(3, tip)
    .intoBytes();

  it("reads the fee coins and gas limit", () => {
    expect(authInfoFee(authInfo)).toEqual({
      amount: [{ denom: "uatom", amount: "4000" }],
      gas: "200000",
    });
  });

  it("replaces the coins and keeps every other byte", () => {
    const rewritten = withAuthInfoFee(authInfo, { denom: "uatom", amount: "6000" });
    expect(authInfoFee(rewritten)).toEqual({
      amount: [{ denom: "uatom", amount: "6000" }],
      gas: "200000",
    });
    const before = readProtoFields(authInfo);
    const after = readProtoFields(rewritten);
    expect(after.map((field) => field.field)).toEqual([1, 2, 3]);
    expect(after[0]?.raw).toEqual(before[0]?.raw);
    expect(after[2]?.raw).toEqual(before[2]?.raw);
    const feeFields = readProtoFields(after[1]?.bytes ?? new Uint8Array());
    expect(feeFields.map((field) => field.field)).toEqual([1, 2, 4]);
    expect(new TextDecoder().decode(feeFields[2]?.bytes)).toBe("cosmos1granter");
  });

  it("gives up on bytes it cannot read", () => {
    expect(authInfoFee(Uint8Array.from([0x12, 0x09, 0x01]))).toBeNull();
    expect(authInfoFee(new ProtoWriter().repeatedMessage(1, [signerInfo]).intoBytes())).toBeNull();
    expect(() =>
      withAuthInfoFee(new ProtoWriter().repeatedMessage(1, [signerInfo]).intoBytes(), {
        denom: "uatom",
        amount: "1",
      }),
    ).toThrow(/no single fee/);
  });
});
