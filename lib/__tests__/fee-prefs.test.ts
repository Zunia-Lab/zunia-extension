import { describe, expect, it } from "vitest";

import { maxSendable, reservedFeeUnits } from "../fee-prefs";

describe("maxSendable", () => {
  it("leaves the reserved fee behind", () => {
    expect(maxSendable(1_000_000n, 9_056n)).toBe(990_944n);
  });

  it("is zero when the fee eats the balance", () => {
    expect(maxSendable(100n, 200n)).toBe(0n);
  });
});

describe("reservedFeeUnits", () => {
  it("reserves gas when the spend denom pays fees on Safro", () => {
    const reserved = reservedFeeUnits("safrochain-1", "usaf", {
      feeSpeed: "average",
      gasAdjustment: 1.4,
    });
    expect(reserved).toBeGreaterThan(0n);
  });

  it("reserves nothing when the spend denom is not the fee denom", () => {
    expect(
      reservedFeeUnits("cosmoshub-4", "ibc/14F9BC", {
        feeSpeed: "average",
        gasAdjustment: 1.4,
      }),
    ).toBe(0n);
  });
});
