import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearApprovals,
  enqueueApprovalWithId,
  rejectApproval,
  resetApprovalsForTests,
} from "../approvals";
import type { OriginGrant, PermissionStore } from "../permissions";
import { ProviderError, providerErrorCode } from "../provider-errors";
import { grantChangeEvents, nextGrantExpiry, pageEventFor } from "../provider-events";
import { SECURITY_CONFIG } from "../../config/security";

const A = "https://a.example";
const B = "https://b.example";

function grant(origin: string, chainIds: string[], extra: Partial<OriginGrant> = {}): OriginGrant {
  return {
    origin,
    chainIds,
    expiresAt: null,
    createdAt: 1,
    lastUsedAt: null,
    accounts: {},
    ...extra,
  };
}

function store(...grants: OriginGrant[]): PermissionStore {
  return Object.fromEntries(grants.map((g) => [g.origin, g]));
}

describe("grantChangeEvents", () => {
  it("tells a newly connected site its chains", () => {
    expect(grantChangeEvents({}, store(grant(A, ["cosmoshub-4"])))).toEqual([
      { origin: A, event: "chainChanged", data: { chainIds: ["cosmoshub-4"] } },
    ]);
  });

  it("sends the whole list when a chain is added", () => {
    const events = grantChangeEvents(
      store(grant(A, ["cosmoshub-4"])),
      store(grant(A, ["osmosis-1", "cosmoshub-4"])),
    );
    expect(events).toEqual([
      { origin: A, event: "chainChanged", data: { chainIds: ["cosmoshub-4", "osmosis-1"] } },
    ]);
  });

  it("names the chains lost, then what is left", () => {
    const events = grantChangeEvents(
      store(grant(A, ["cosmoshub-4", "osmosis-1"])),
      store(grant(A, ["cosmoshub-4"])),
    );
    expect(events).toEqual([
      { origin: A, event: "disconnect", data: { chainIds: ["osmosis-1"] } },
      { origin: A, event: "chainChanged", data: { chainIds: ["cosmoshub-4"] } },
    ]);
  });

  it("disconnects only the site whose grant is gone", () => {
    const events = grantChangeEvents(
      store(grant(A, ["cosmoshub-4"]), grant(B, ["osmosis-1"])),
      store(grant(B, ["osmosis-1"])),
    );
    expect(events).toEqual([{ origin: A, event: "disconnect", data: null }]);
  });

  it("stays quiet when only bookkeeping changed", () => {
    const before = store(grant(A, ["cosmoshub-4", "osmosis-1"]));
    const after = store(
      grant(A, ["osmosis-1", "cosmoshub-4"], {
        lastUsedAt: 99,
        accounts: { "cosmoshub-4": "cosmos1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu" },
      }),
    );
    expect(grantChangeEvents(before, after)).toEqual([]);
  });

  it("disconnects every site when the store is wiped", () => {
    const events = grantChangeEvents(store(grant(B, ["x-1"]), grant(A, ["y-1"])), {});
    expect(events.map((e) => [e.origin, e.event])).toEqual([
      [A, "disconnect"],
      [B, "disconnect"],
    ]);
  });
});

describe("nextGrantExpiry", () => {
  it("returns the earliest expiry, ignoring grants that never expire", () => {
    expect(nextGrantExpiry({})).toBeNull();
    expect(nextGrantExpiry(store(grant(A, ["x-1"])))).toBeNull();
    expect(
      nextGrantExpiry(
        store(grant(A, ["x-1"], { expiresAt: 500 }), grant(B, ["x-1"], { expiresAt: 200 })),
      ),
    ).toBe(200);
  });
});

describe("pageEventFor", () => {
  it("drops events for another origin, for nobody, or of an unknown kind", () => {
    expect(pageEventFor({ event: "locked", origin: B }, A)).toBeNull();
    expect(pageEventFor({ event: "locked" }, A)).toBeNull();
    expect(pageEventFor({ event: "settingsChanged", origin: A }, A)).toBeNull();
    expect(pageEventFor(null, A)).toBeNull();
  });

  it("passes chain lists only where they mean something", () => {
    expect(pageEventFor({ event: "accountsChanged", origin: A, data: { chainIds: ["x"] } }, A)).toEqual({
      event: "accountsChanged",
      data: null,
    });
    expect(pageEventFor({ event: "disconnect", origin: A, data: null }, A)).toEqual({
      event: "disconnect",
      data: null,
    });
    expect(pageEventFor({ event: "disconnect", origin: A, data: { chainIds: ["x-1"] } }, A)).toEqual({
      event: "disconnect",
      data: { chainIds: ["x-1"] },
    });
    expect(
      pageEventFor({ event: "chainChanged", origin: A, data: { chainIds: ["x-1", 7, null] } }, A),
    ).toEqual({ event: "chainChanged", data: { chainIds: ["x-1"] } });
  });
});

describe("error codes on approvals", () => {
  beforeEach(() => resetApprovalsForTests());
  afterEach(() => {
    vi.useRealTimers();
    resetApprovalsForTests();
  });

  const request = () =>
    enqueueApprovalWithId({ kind: "enable", origin: A, chainIds: ["cosmoshub-4"], title: "Connect" });

  it("a rejection uses Keplr's wording", async () => {
    const { id, result } = request();
    rejectApproval(id);
    await expect(result).rejects.toMatchObject({ code: "USER_REJECTED", message: "Request rejected" });
  });

  it("locking the wallet rejects with LOCKED", async () => {
    const { result } = request();
    clearApprovals();
    await expect(result).rejects.toMatchObject({ code: "LOCKED" });
  });

  it("an unanswered request expires as a rejection", async () => {
    vi.useFakeTimers();
    const { result } = request();
    const settled = expect(result).rejects.toMatchObject({
      code: "USER_REJECTED",
      message: "Request expired before it was answered",
    });
    await vi.advanceTimersByTimeAsync(SECURITY_CONFIG.approvals.ttlMs);
    await settled;
  });
});

describe("providerErrorCode", () => {
  it("reads a code off errors and responses, and falls back to INTERNAL", () => {
    expect(providerErrorCode(new ProviderError("LOCKED", "x"))).toBe("LOCKED");
    expect(providerErrorCode({ ok: false, error: "x", code: "NOT_CONNECTED" })).toBe("NOT_CONNECTED");
    expect(providerErrorCode({ code: "SOMETHING_ELSE" })).toBe("INTERNAL");
    expect(providerErrorCode(new Error("x"))).toBe("INTERNAL");
    expect(providerErrorCode(undefined)).toBe("INTERNAL");
  });
});
