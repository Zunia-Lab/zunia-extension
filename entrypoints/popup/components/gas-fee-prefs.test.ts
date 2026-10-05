import { describe, expect, it } from "vitest";

import { formatUnits } from "../../../lib/format";
import { feeLabelText } from "./GasFeePrefs";

/**
 * The fee row every confirm screen shows (Send, Swap, Earn, Governance, NFT).
 * It used the compact list format, so a fee of 0.004012 OSMO read
 * `Tx Fee: 0.00 OSMO` (WP-H review). It now follows lib/token-amount.ts
 * `confirm`: exact to six decimals, cut and never rounded up, and never 0 for
 * a fee that is not 0.
 */
describe("the fee row", () => {
  it("shows a fee under a cent of a coin as it is, not as 0.00", () => {
    // What the row showed before.
    expect(formatUnits("4012", 6)).toBe("0.00");
    expect(feeLabelText("4012", 6, "OSMO")).toBe("Tx Fee: 0.004012 OSMO");
    expect(feeLabelText("5000", 6, "ATOM")).toBe("Tx Fee: 0.005 ATOM");
    // An Injective fee at 18 decimals.
    expect(feeLabelText("80000000000000", 18, "INJ")).toBe("Tx Fee: 0.00008 INJ");
  });

  it("never rounds a fee up", () => {
    expect(feeLabelText("999999", 6, "OSMO")).toBe("Tx Fee: 0.999999 OSMO");
    expect(feeLabelText("1999999999", 6, "OSMO")).toBe("Tx Fee: 1999.999999 OSMO");
    // Cut at six decimals: 0.123456789… reads 0.123456, never 0.123457.
    expect(feeLabelText("123456789012345678", 18, "INJ")).toBe("Tx Fee: 0.123456 INJ");
    // Never compact: 25000 OSMO is not "25.00k".
    expect(feeLabelText("25000000000", 6, "OSMO")).toBe("Tx Fee: 25000 OSMO");
  });

  it("never shows a fee that is not 0 as 0", () => {
    expect(feeLabelText("123", 18, "INJ")).toBe("Tx Fee: <0.000001 INJ");
    expect(feeLabelText("1", 6, "OSMO")).toBe("Tx Fee: 0.000001 OSMO");
    expect(feeLabelText("0", 6, "OSMO")).toBe("Tx Fee: 0 OSMO");
  });

  it("says when there is no fee yet", () => {
    expect(feeLabelText(undefined, 6, "ATOM")).toBe("Tx Fee: — ATOM");
  });
});
