import { describe, expect, it } from "vitest";

import { BroadcastError } from "../broadcast";
import { claimFallbackGas, claimTargets, hasClaimable, MAX_CLAIM_MSGS } from "../claim-plan";
import { otherRewardCoins } from "../chain-queries";
import { withIssuer } from "../notices";
import {
  feeAmountFor,
  isInsufficientFee,
  parseMinGasPrices,
  planFee,
  requiredFeeOf,
  simulateGas,
  toRatio,
} from "../tx-fee";

describe("exact gas price math", () => {
  it("never loses digits on an 18-decimal chain", () => {
    // 3.6M gas at 1.5e9 inj/gas = 5.4e15: past what a float multiplies exactly once a fraction joins in.
    expect(feeAmountFor(3_600_001n, toRatio(1_500_000_000))).toBe(5_400_001_500_000_000n);
    // The mobile app's mistake: 6.4e13 required, 3.69e12 quoted.
    expect(feeAmountFor(400_000n, toRatio("160000000"))).toBe(64_000_000_000_000n);
    expect(feeAmountFor(150_000n, toRatio(0.075))).toBe(11_250n);
    expect(feeAmountFor(1n, toRatio("1e-7"))).toBe(1n);
  });

  it("parses the node's minimum_gas_price list", () => {
    const rows = parseMinGasPrices("0.025uatom,0.0025ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2;160000000inj");
    expect(rows.map((r) => r.denom)).toEqual(["uatom", "ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2", "inj"]);
    expect(parseMinGasPrices("")).toEqual([]);
    expect(parseMinGasPrices(undefined)).toEqual([]);
  });
});

describe("planFee", () => {
  const base = { callerGas: 250_000n, callerFee: [], feeDenom: "uatom", walletPrice: toRatio(0.025), nodeMinPrice: null, simulatedGas: null, gasAdjustment: 1.4 };

  it("keeps the screen's gas when nothing simulated", () => {
    const plan = planFee(base);
    expect(plan.gasSource).toBe("fallback");
    expect(plan.fee).toEqual({ amount: [{ denom: "uatom", amount: "6250" }], gas: "250000" });
  });

  it("sizes gas from the simulation and the adjustment", () => {
    const plan = planFee({ ...base, simulatedGas: 150_000n });
    expect(plan.gas).toBe(210_000n);
    expect(plan.fee.amount[0]?.amount).toBe("5250");
  });

  it("raises the price to the node's minimum", () => {
    const plan = planFee({ ...base, nodeMinPrice: toRatio("0.1"), simulatedGas: 100_000n });
    expect(plan.fee.amount[0]?.amount).toBe("14000");
  });

  it("never prices below what the screen quoted", () => {
    const plan = planFee({ ...base, callerFee: [{ denom: "uatom", amount: "25000" }], simulatedGas: 100_000n });
    // quoted 0.1 per gas
    expect(plan.fee.amount[0]?.amount).toBe("14000");
  });

  it("gives a free chain an empty fee list", () => {
    expect(planFee({ ...base, walletPrice: toRatio(0) }).fee.amount).toEqual([]);
  });
});

describe("node refusals", () => {
  it("reads the fee a node asks for", () => {
    const err = new BroadcastError("insufficient fees; got: 100uosmo required: 2500uosmo: insufficient fee", 13, "");
    expect(isInsufficientFee(err)).toBe(true);
    expect(requiredFeeOf(err)).toEqual({ denom: "uosmo", amount: 2500n });
    expect(isInsufficientFee(new Error("account sequence mismatch"))).toBe(false);
  });
});

describe("simulateGas", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  it("returns gas used", async () => {
    expect(await simulateGas(async () => ({ status: 200, body: { gas_info: { gas_used: "75123" } } }), bytes)).toBe(75123n);
  });
  it("falls back when the node cannot simulate", async () => {
    expect(await simulateGas(async () => ({ status: 501, body: {} }), bytes)).toBeNull();
    expect(await simulateGas(async () => { throw new Error("timeout"); }, bytes)).toBeNull();
  });
  it("refuses to sign what the node already ran and failed", async () => {
    await expect(
      simulateGas(async () => ({ status: 400, body: { message: "failed to execute message; message index: 0: no delegation distribution info" } }), bytes),
    ).rejects.toThrow(/no delegation/);
  });
});

describe("claim targets", () => {
  const row = (v: string, rewards: string, other: Array<{ denom: string; amount: string }> = []) => ({ validatorAddress: v, rewards, otherRewards: other });

  it("skips empty positions, keeps other-denom rewards, orders by reward", () => {
    const { targets } = claimTargets([row("a", "0"), row("b", "5"), row("c", "0", [{ denom: "uion", amount: "3" }]), row("d", "50"), row("b", "5")]);
    expect(targets.map((t) => t.validatorAddress)).toEqual(["d", "b", "c"]);
  });

  it("caps a transaction and reports how many wait", () => {
    const rows = Array.from({ length: 45 }, (_, i) => row(`v${i}`, String(i + 1)));
    const { targets, skipped } = claimTargets(rows);
    expect(targets).toHaveLength(MAX_CLAIM_MSGS);
    expect(skipped).toBe(25);
    expect(claimTargets([]).targets).toEqual([]);
  });

  it("scales fallback gas with the message count", () => {
    expect(claimFallbackGas(1)).toBe(400_000);
    expect(claimFallbackGas(20)).toBe(7_000_000);
    expect(hasClaimable({ rewards: "0" })).toBe(false);
  });

  it("reads fractional multi-denom DecCoins", () => {
    expect(otherRewardCoins([{ denom: "uatom", amount: "9.9" }, { denom: "uion", amount: "12.7" }, { denom: "uion", amount: "0.4" }, { denom: "ufoo", amount: "0.9" }], "uatom")).toEqual([
      { denom: "uion", amount: "12" },
    ]);
  });
});

describe("issuer in notices", () => {
  const usdc = { name: "Injective USDC", ticker: "USDC.inj", originChainId: "injective-1", decimalsKnown: true };
  it("names what arrived and where it comes from", () => {
    expect(withIssuer("15 USDC.inj", usdc, "safrochain-1")).toBe("15 USDC.inj (Injective USDC)");
  });
  it("leaves the home chain, and unnamed coins, alone", () => {
    expect(withIssuer("15 USDC.inj", usdc, "injective-1")).toBe("15 USDC.inj");
    expect(withIssuer("12 base units ibc/AB…", { ...usdc, name: "Unknown token", ticker: "IBC·AB", originChainId: null }, "x")).toBe("12 base units ibc/AB…");
  });
});
