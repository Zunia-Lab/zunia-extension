import { describe, expect, it } from "vitest";
import type { RoutePlan } from "@zunialab/interchain";

import type { TrackedRoute } from "../packet-tracking";
import { outcomeAlert, routeOutcome } from "../transfer-watch";

function route(overrides: Partial<TrackedRoute>): TrackedRoute {
  return {
    hops: [],
    status: "pending",
    failure: null,
    stalled: false,
    currentHopIndex: 0,
    estimatedDurationSeconds: 60,
    elapsedSeconds: null,
    updatedAt: 0,
    settled: false,
    recovery: null,
    notes: [],
    ...overrides,
  };
}

const PLAN = { sourceChainId: "cosmoshub-4", destChainId: "osmosis-1" } as RoutePlan;

describe("routeOutcome", () => {
  it("waits while the route can still move", () => {
    expect(routeOutcome(route({ status: "relayed" }))).toBeNull();
    expect(routeOutcome(route({ failure: "stalled", stalled: true }))).toBeNull();
  });

  it("names what happened to the funds once it settles", () => {
    expect(routeOutcome(route({ settled: true, status: "acknowledged" }))).toBe("delivered");
    expect(routeOutcome(route({ settled: true, status: "timeout", failure: "timeout" }))).toBe(
      "refunded",
    );
    expect(routeOutcome(route({ settled: true, status: "failed", failure: "ack-error" }))).toBe(
      "refunded",
    );
    expect(
      routeOutcome(route({ settled: true, status: "acknowledged", failure: "swap-delivery-failed" })),
    ).toBe("recoverable");
  });
});

describe("outcomeAlert", () => {
  const swap = { kind: "swap" as const, label: "1 ATOM → OSMO", chainId: "cosmoshub-4", plan: PLAN };
  const transfer = { ...swap, kind: "transfer" as const, label: "1 ATOM → Osmosis" };

  it("says where a delivered route arrived", () => {
    expect(outcomeAlert(swap, route({}), "delivered")).toEqual({
      title: "Swap complete",
      message: "1 ATOM → OSMO arrived on Osmosis.",
    });
    expect(outcomeAlert(transfer, route({}), "delivered").title).toBe("Transfer arrived");
  });

  it("tells a timeout from a refusal, and both say where the tokens go", () => {
    const timedOut = outcomeAlert(transfer, route({ failure: "timeout" }), "refunded");
    expect(timedOut.title).toBe("Transfer timed out");
    expect(timedOut.message).toContain("Cosmos Hub");
    const refused = outcomeAlert(swap, route({ failure: "ack-error" }), "refunded");
    expect(refused.title).toBe("Swap did not go through");
    expect(refused.message).toContain("Cosmos Hub");
  });

  it("asks for action when a swap output waits to be recovered", () => {
    expect(outcomeAlert(swap, route({}), "recoverable").title).toBe("Swap needs your action");
  });
});
