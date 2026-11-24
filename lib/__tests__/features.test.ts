import { describe, expect, it } from "vitest";
import { SWAP_ENABLED, withoutSwap } from "../features";

const TABS = [{ id: "home" }, { id: "earn" }, { id: "swap" }, { id: "activity" }] as const;

describe("store-dependent features", () => {
  it("keeps swaps outside the Safari build", () => {
    // Tests build for no browser in particular, which is not Safari.
    expect(SWAP_ENABLED).toBe(true);
  });

  it("drops only the swap entry when swaps are off", () => {
    expect(withoutSwap(TABS, false).map((tab) => tab.id)).toEqual(["home", "earn", "activity"]);
    expect(withoutSwap(TABS, true).map((tab) => tab.id)).toEqual(["home", "earn", "swap", "activity"]);
  });
});
