import { describe, expect, it } from "vitest";
import {
  MAX_HISTORY,
  pushLocation,
  withEarnPick,
  type PopupLocation,
} from "./routes";

describe("popup history", () => {
  it("pushes views and pops back to where the user came from", () => {
    let stack: PopupLocation[] = [];
    stack = pushLocation(stack, { route: "settings" });
    stack = pushLocation(stack, { route: "security" });
    stack = pushLocation(stack, { route: "reveal" });
    expect(stack.map((l) => l.route)).toEqual(["settings", "security", "reveal"]);
    expect(stack.slice(0, -1).at(-1)?.route).toBe("security");
  });

  it("starts over on a tab root", () => {
    const stack = pushLocation([{ route: "chain", chainId: "osmosis-1" }], {
      route: "swap",
      chainId: "osmosis-1",
    });
    expect(stack).toEqual([{ route: "swap", chainId: "osmosis-1" }]);
    expect(pushLocation(stack, { route: "home" })).toEqual([]);
  });

  it("does not stack the same view twice", () => {
    const stack = pushLocation([{ route: "chain", chainId: "a" }], {
      route: "chain",
      chainId: "a",
    });
    expect(stack).toHaveLength(1);
    expect(pushLocation(stack, { route: "chain", chainId: "b" })).toHaveLength(2);
  });

  it("sends the old Bridge view to Send on another chain", () => {
    expect(pushLocation([], { route: "bridge", chainId: "osmosis-1" })).toEqual([
      { route: "send", chainId: "osmosis-1", sendMode: "cross" },
    ]);
    expect(pushLocation([], { route: "bridge" })).toEqual([
      { route: "send", sendMode: "cross" },
    ]);
  });

  it("treats the two Send modes as different views", () => {
    const stack = pushLocation([{ route: "send", chainId: "a" }], {
      route: "send",
      chainId: "a",
      sendMode: "cross",
    });
    expect(stack).toHaveLength(2);
    expect(pushLocation(stack, { route: "bridge", chainId: "a" })).toHaveLength(2);
  });

  it("keeps a bounded history", () => {
    let stack: PopupLocation[] = [];
    for (let i = 0; i < MAX_HISTORY + 10; i++) {
      stack = pushLocation(stack, { route: "chain", chainId: `c${i}` });
    }
    expect(stack).toHaveLength(MAX_HISTORY);
    expect(stack.at(-1)?.chainId).toBe(`c${MAX_HISTORY + 9}`);
  });

  it("keeps Earn's network and pick across a validator page", () => {
    let stack: PopupLocation[] = pushLocation([], { route: "earn" });
    stack = withEarnPick(stack, "cosmoshub-4", "cosmosvaloper1abc");
    stack = pushLocation(stack, {
      route: "validator",
      chainId: "cosmoshub-4",
      operatorAddress: "cosmosvaloper1xyz",
    });
    const back = stack.slice(0, -1);
    expect(back).toEqual([
      { route: "earn", chainId: "cosmoshub-4", operatorAddress: "cosmosvaloper1abc" },
    ]);
    expect(withEarnPick(back, "osmosis-1", null)).toEqual([
      { route: "earn", chainId: "osmosis-1" },
    ]);
  });

  it("leaves the history alone when Earn is not on top", () => {
    const stack: PopupLocation[] = [{ route: "earn" }, { route: "chain", chainId: "a" }];
    expect(withEarnPick(stack, "a", "valoper")).toBe(stack);
  });

  it("opens Earn from a validator page as a fresh tab with the pick", () => {
    const stack = pushLocation(
      [{ route: "chain", chainId: "a" }, { route: "validator", chainId: "a", operatorAddress: "v" }],
      { route: "earn", chainId: "a", operatorAddress: "v" },
    );
    expect(stack).toEqual([{ route: "earn", chainId: "a", operatorAddress: "v" }]);
  });
});
