import { bech32 } from "@scure/base";
import { describe, expect, it } from "vitest";

import { SWAP_FEE_BPS } from "../../config/fees";
import {
  BANK_SEND_TYPE_URL,
  buildSwapFeeMsg,
  feeRateText,
  readSwapFeeMsg,
  sameSwapFee,
  swapFeeFor,
  swapFeeIssues,
  swapFeeRecipient,
  swapFeeRecipientProblem,
  type SwapFee,
  type SwapFeeRecipients,
} from "../swap-fee";

/**
 * Zunia's swap commission as lib/swap-fee.ts works it out, builds it and
 * checks it. Every test injects its own treasury map: the shipped one
 * (config/fees.ts) is empty until the owner fills it, and these tests must
 * not change meaning when it is filled.
 */

/** A bech32 address with `prefix`, `bytes` long, every byte `fill`. */
const address = (prefix: string, fill: number, bytes = 20): string =>
  bech32.encode(prefix, bech32.toWords(new Uint8Array(bytes).fill(fill)));

const OSMO_TREASURY = address("osmo", 0x5a);
const HUB_TREASURY = address("cosmos", 0x5a);
const INJ_TREASURY = address("inj", 0x5b);
const ME = address("osmo", 1);
const SOMEONE = address("osmo", 7);

const RECIPIENTS: SwapFeeRecipients = {
  "osmosis-1": OSMO_TREASURY,
  "cosmoshub-4": HUB_TREASURY,
  "injective-1": INJ_TREASURY,
};

const NONE = (amount: bigint): SwapFee => ({ bps: 0, fee: 0n, net: amount, recipient: null });

describe("the fee on a swap", () => {
  it("is 50 basis points of the amount sold, with the rest swapped", () => {
    expect(SWAP_FEE_BPS).toBe(50);
    // 63 OSMO: 0.315 OSMO to the treasury, 62.685 OSMO swapped.
    expect(swapFeeFor("osmosis-1", 63_000_000n, RECIPIENTS)).toEqual({
      bps: 50,
      fee: 315_000n,
      net: 62_685_000n,
      recipient: OSMO_TREASURY,
    });
    // 1 ATOM on the Hub: 0.005 ATOM there, 0.995 ATOM sent to the swap.
    expect(swapFeeFor("cosmoshub-4", 1_000_000n, RECIPIENTS)).toEqual({
      bps: 50,
      fee: 5_000n,
      net: 995_000n,
      recipient: HUB_TREASURY,
    });
  });

  it("rounds down, so rounding only ever favours the user", () => {
    // 1999 × 50 / 10000 = 9.995: the fee is 9, never 10.
    expect(swapFeeFor("osmosis-1", 1_999n, RECIPIENTS)).toMatchObject({ fee: 9n, net: 1_990n });
    expect(swapFeeFor("osmosis-1", 2_000n, RECIPIENTS)).toMatchObject({ fee: 10n, net: 1_990n });
    expect(swapFeeFor("osmosis-1", 2_001n, RECIPIENTS)).toMatchObject({ fee: 10n, net: 1_991n });
  });

  it("charges nothing on dust too small to carry one base unit of fee", () => {
    for (const amount of [1n, 2n, 100n, 199n]) {
      expect(swapFeeFor("osmosis-1", amount, RECIPIENTS)).toEqual(NONE(amount));
    }
    // From 200 base units on, one base unit.
    expect(swapFeeFor("osmosis-1", 200n, RECIPIENTS)).toEqual({
      bps: 50,
      fee: 1n,
      net: 199n,
      recipient: OSMO_TREASURY,
    });
    // Nothing to charge on nothing, or on a negative amount.
    expect(swapFeeFor("osmosis-1", 0n, RECIPIENTS)).toEqual(NONE(0n));
    expect(swapFeeFor("osmosis-1", -5_000n, RECIPIENTS)).toEqual(NONE(-5_000n));
  });

  it("works in bigint at any size, far past what a double holds", () => {
    // INJ has 18 decimals: about 1.5 INJ is already beyond 2^53 base units.
    expect(swapFeeFor("injective-1", 1_499_999_999_999_999_999n, RECIPIENTS)).toEqual({
      bps: 50,
      fee: 7_499_999_999_999_999n,
      net: 1_492_500_000_000_000_000n,
      recipient: INJ_TREASURY,
    });
    const huge = 10n ** 40n + 12_345n;
    const { fee, net } = swapFeeFor("osmosis-1", huge, RECIPIENTS);
    expect(fee).toBe((huge * 50n) / 10_000n);
    expect(fee).toBe(5n * 10n ** 37n + 61n);
    expect(fee + net).toBe(huge);
  });

  it("always splits the whole amount: fee and swap add up to what the user pays", () => {
    for (let amount = 1n; amount < 5_000n; amount += 7n) {
      const { fee, net } = swapFeeFor("osmosis-1", amount, RECIPIENTS);
      expect(fee + net).toBe(amount);
      expect(fee).toBe((amount * 50n) / 10_000n);
      expect(net).toBeGreaterThan(0n);
    }
  });

  it("charges nothing on a chain with no treasury", () => {
    expect(swapFeeFor("noble-1", 1_000_000n, RECIPIENTS)).toEqual(NONE(1_000_000n));
    expect(swapFeeFor("osmosis-1", 1_000_000n, {})).toEqual(NONE(1_000_000n));
    // Only the map's own entries count, never what an object inherits.
    for (const key of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(swapFeeRecipient(key, RECIPIENTS)).toBeNull();
      expect(swapFeeFor(key, 1_000_000n, RECIPIENTS)).toEqual(NONE(1_000_000n));
    }
  });

  it("charges nothing at a rate that is not a whole number of basis points below 100%", () => {
    expect(swapFeeFor("osmosis-1", 1_000_000n, RECIPIENTS, 25)).toMatchObject({ bps: 25, fee: 2_500n });
    for (const bps of [0, -50, 10_000, 20_000, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(swapFeeFor("osmosis-1", 1_000_000n, RECIPIENTS, bps)).toEqual(NONE(1_000_000n));
    }
  });

  it("says its rate in percent, from whole numbers", () => {
    expect(feeRateText(50)).toBe("0.5%");
    expect(feeRateText(SWAP_FEE_BPS)).toBe("0.5%");
    expect(feeRateText(25)).toBe("0.25%");
    expect(feeRateText(5)).toBe("0.05%");
    expect(feeRateText(10)).toBe("0.1%");
    expect(feeRateText(100)).toBe("1%");
    expect(feeRateText(150)).toBe("1.5%");
  });

  it("is the same fee only when every part is", () => {
    const fee = swapFeeFor("osmosis-1", 63_000_000n, RECIPIENTS);
    expect(sameSwapFee(fee, { ...fee })).toBe(true);
    expect(sameSwapFee(fee, { ...fee, fee: fee.fee + 1n })).toBe(false);
    expect(sameSwapFee(fee, { ...fee, net: fee.net - 1n })).toBe(false);
    expect(sameSwapFee(fee, { ...fee, recipient: SOMEONE })).toBe(false);
    expect(sameSwapFee(fee, { ...fee, bps: 49 })).toBe(false);
  });
});

describe("the treasury a chain pays", () => {
  it("is an address with the chain's own prefix, checksum included", () => {
    expect(swapFeeRecipientProblem("osmosis-1", OSMO_TREASURY)).toBeNull();
    expect(swapFeeRecipientProblem("injective-1", INJ_TREASURY)).toBeNull();
    // A contract (a DAO treasury) holds 32 bytes.
    expect(swapFeeRecipientProblem("osmosis-1", address("osmo", 3, 32))).toBeNull();
  });

  it("is never another chain's address, which charges nothing rather than paying it", () => {
    // An Osmosis address listed for the Hub, and the Hub's for Injective.
    const wrong: SwapFeeRecipients = { "cosmoshub-4": OSMO_TREASURY, "injective-1": HUB_TREASURY };
    expect(swapFeeRecipientProblem("cosmoshub-4", OSMO_TREASURY)).toMatch(/prefix osmo, not cosmoshub-4's cosmos/);
    expect(swapFeeRecipient("cosmoshub-4", wrong)).toBeNull();
    expect(swapFeeRecipient("injective-1", wrong)).toBeNull();
    expect(swapFeeFor("cosmoshub-4", 1_000_000n, wrong)).toEqual(NONE(1_000_000n));
  });

  it("refuses a broken checksum, mixed or upper case, a wrong length and an unbundled chain", () => {
    const flipped = `${OSMO_TREASURY.slice(0, -1)}${OSMO_TREASURY.endsWith("q") ? "p" : "q"}`;
    expect(swapFeeRecipientProblem("osmosis-1", flipped)).toMatch(/not a valid bech32/);
    expect(swapFeeRecipientProblem("osmosis-1", OSMO_TREASURY.toUpperCase())).toMatch(/lowercase/);
    expect(swapFeeRecipientProblem("osmosis-1", address("osmo", 1, 16))).toMatch(/16 bytes/);
    expect(swapFeeRecipientProblem("osmosis-1", "")).toMatch(/not a valid bech32/);
    expect(swapFeeRecipientProblem("my-own-chain-1", OSMO_TREASURY)).toMatch(/not a chain this release bundles/);
    for (const bad of [flipped, OSMO_TREASURY.toUpperCase(), address("osmo", 1, 16)]) {
      expect(swapFeeRecipient("osmosis-1", { "osmosis-1": bad })).toBeNull();
    }
  });
});

describe("the message that pays it", () => {
  const paid = () =>
    buildSwapFeeMsg({ sender: ME, recipient: OSMO_TREASURY, denom: "uosmo", amount: 315_000n });

  it("is a bank send in the kernel's MsgSend shape: from the signer, to the treasury, one coin", () => {
    expect(paid()).toEqual({
      typeUrl: "/cosmos.bank.v1beta1.MsgSend",
      value: {
        from_address: ME,
        to_address: OSMO_TREASURY,
        amount: [{ denom: "uosmo", amount: "315000" }],
      },
    });
    expect(BANK_SEND_TYPE_URL).toBe("/cosmos.bank.v1beta1.MsgSend");
    // The field order the amino `msgSend` writes, so the JSON reads the same.
    expect(JSON.stringify(paid())).toBe(
      `{"typeUrl":"/cosmos.bank.v1beta1.MsgSend","value":{"from_address":"${ME}","to_address":"${OSMO_TREASURY}","amount":[{"denom":"uosmo","amount":"315000"}]}}`,
    );
  });

  it("is never built with nothing to pay or nobody to pay it", () => {
    const base = { sender: ME, recipient: OSMO_TREASURY, denom: "uosmo", amount: 1n };
    expect(() => buildSwapFeeMsg({ ...base, amount: 0n })).toThrow(/above zero/);
    expect(() => buildSwapFeeMsg({ ...base, amount: -1n })).toThrow(/above zero/);
    expect(() => buildSwapFeeMsg({ ...base, recipient: "" })).toThrow();
    expect(() => buildSwapFeeMsg({ ...base, sender: "" })).toThrow();
    expect(() => buildSwapFeeMsg({ ...base, denom: "" })).toThrow();
  });

  it("is read back exactly, and nothing it does not say is read as a fee", () => {
    expect(readSwapFeeMsg(paid())).toEqual({ from: ME, to: OSMO_TREASURY, denom: "uosmo", amount: "315000" });
    const value = paid().value as Record<string, unknown>;
    const coin = { denom: "uosmo", amount: "315000" };
    const unreadable: unknown[] = [
      undefined,
      { typeUrl: "/cosmos.bank.v1beta1.MsgMultiSend", value },
      { typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract", value },
      // A second coin, none, or a field MsgSend does not have.
      { typeUrl: BANK_SEND_TYPE_URL, value: { ...value, amount: [coin, { denom: "uion", amount: "1" }] } },
      { typeUrl: BANK_SEND_TYPE_URL, value: { ...value, amount: [] } },
      { typeUrl: BANK_SEND_TYPE_URL, value: { ...value, amount: coin } },
      { typeUrl: BANK_SEND_TYPE_URL, value: { ...value, memo: "x" } },
      { typeUrl: BANK_SEND_TYPE_URL, value: { ...value, amount: [{ ...coin, extra: 1 }] } },
      // Missing or empty parties.
      { typeUrl: BANK_SEND_TYPE_URL, value: { to_address: OSMO_TREASURY, amount: [coin] } },
      { typeUrl: BANK_SEND_TYPE_URL, value: { ...value, to_address: "" } },
      { typeUrl: BANK_SEND_TYPE_URL, value: { ...value, from_address: 7 } },
      // An amount that is not a positive integer in its one spelling.
      ...["0", "0315000", "315000.5", "-315000", "1e6", " 315000", ""].map((amount) => ({
        typeUrl: BANK_SEND_TYPE_URL,
        value: { ...value, amount: [{ denom: "uosmo", amount }] },
      })),
      { typeUrl: BANK_SEND_TYPE_URL, value: { ...value, amount: [{ denom: "uosmo", amount: 315000 }] } },
      { typeUrl: BANK_SEND_TYPE_URL, value: { ...value, amount: [{ denom: "", amount: "315000" }] } },
    ];
    for (const msg of unreadable) {
      expect(readSwapFeeMsg(msg as never), JSON.stringify(msg)).toBeNull();
    }
  });
});

describe("the check on a transaction's fee message", () => {
  const expected = {
    chainId: "osmosis-1",
    signer: ME,
    denom: "uosmo",
    amountUnits: 63_000_000n,
    recipients: RECIPIENTS,
  } as const;
  const due = swapFeeFor("osmosis-1", 63_000_000n, RECIPIENTS);
  const send = (overrides: Partial<{ sender: string; recipient: string; denom: string; amount: bigint }> = {}) =>
    buildSwapFeeMsg({ sender: ME, recipient: OSMO_TREASURY, denom: "uosmo", amount: 315_000n, ...overrides });

  it("passes exactly the fee owed: from the signer, to the treasury, in the denom sold, for that amount", () => {
    expect(swapFeeIssues(send(), expected)).toEqual([]);
  });

  it("refuses a fee to another address, in another denom, of another amount or from another account", () => {
    const read = (msg: ReturnType<typeof send>) => readSwapFeeMsg(msg)!;
    const elsewhere = send({ recipient: SOMEONE });
    expect(swapFeeIssues(elsewhere, expected)).toEqual([{ kind: "recipient", paid: read(elsewhere), due }]);
    const ion = send({ denom: "uion" });
    expect(swapFeeIssues(ion, expected)).toEqual([{ kind: "denom", paid: read(ion) }]);
    for (const amount of [314_999n, 315_001n, 630_000n]) {
      const other = send({ amount });
      expect(swapFeeIssues(other, expected)).toEqual([{ kind: "amount", paid: read(other), due }]);
    }
    const theirs = send({ sender: SOMEONE });
    expect(swapFeeIssues(theirs, expected)).toEqual([{ kind: "sender", paid: read(theirs) }]);
    // Every difference at once is every issue.
    const all = send({ sender: SOMEONE, recipient: SOMEONE, amount: 1n });
    expect(swapFeeIssues(all, expected).map((issue) => issue.kind)).toEqual(["sender", "recipient", "amount"]);
  });

  it("refuses a fee when none is owed, and a transaction that leaves out a fee that is", () => {
    // No treasury on the chain: any fee message is refused, even one to a real treasury.
    expect(swapFeeIssues(send(), { ...expected, recipients: {} })).toEqual([
      { kind: "not-due", paid: readSwapFeeMsg(send()) },
    ]);
    // Dust carries no fee, so it pays none.
    expect(swapFeeIssues(send({ amount: 1n }), { ...expected, amountUnits: 150n })).toEqual([
      { kind: "not-due", paid: readSwapFeeMsg(send({ amount: 1n })) },
    ]);
    expect(swapFeeIssues(undefined, expected)).toEqual([{ kind: "missing", due }]);
    // No fee owed, no fee message: nothing to say.
    expect(swapFeeIssues(undefined, { ...expected, recipients: {} })).toEqual([]);
    expect(swapFeeIssues(undefined, { ...expected, amountUnits: 150n })).toEqual([]);
  });

  it("refuses a second message it cannot read as a fee", () => {
    const call = { typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract", value: { sender: ME, contract: SOMEONE, msg: "e30=", funds: [] } };
    expect(swapFeeIssues(call, expected)).toEqual([{ kind: "unreadable" }]);
    expect(swapFeeIssues(call, { ...expected, recipients: {} })).toEqual([{ kind: "unreadable" }]);
  });

  it("works the fee owed out again from the configuration, whatever the caller believes", () => {
    // Another treasury map is another fee owed: the same message fails it.
    const moved: SwapFeeRecipients = { "osmosis-1": SOMEONE };
    expect(swapFeeIssues(send(), { ...expected, recipients: moved }).map((issue) => issue.kind)).toEqual([
      "recipient",
    ]);
  });
});
