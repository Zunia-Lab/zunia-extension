import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  aminoSignDocChainId,
  assertSameChain,
  assertSigner,
  bytesFromWire,
  directSignDocToWire,
  encodeDirectSignDoc,
  normalizeDirectSignDoc,
  u64FromWire,
} from "../provider-guards";
import {
  ChainDraftError,
  cleanEndpoint,
  draftFromSuggestedChain,
  validateCustomChainDraft,
  type CustomChainDraft,
} from "../chain-draft";
import { assessOrigin } from "../origin-risk";
import {
  EMPTY_THROTTLE,
  PasswordThrottledError,
  assertNotThrottled,
  readThrottleState,
  recordFailure,
  throttleDelayMs,
} from "../password-throttle";
import {
  classifySender,
  messageAllowed,
  providerOriginFromSender,
  type SenderContext,
} from "../sender-policy";
import {
  enqueueApprovalWithId,
  extendApprovalChains,
  findPendingEnable,
  getPendingApprovals,
  onApprovalsChanged,
  rejectApprovalsWhere,
  resetApprovalsForTests,
  resolveApproval,
  setApprovalHost,
} from "../approvals";
import { SECURITY_CONFIG } from "../../config/security";

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

describe("encodeDirectSignDoc", () => {
  it("matches the CosmJS makeSignBytes encoding", () => {
    const bytes = encodeDirectSignDoc({
      bodyBytes: Uint8Array.from([1, 2, 3]),
      authInfoBytes: Uint8Array.from([4, 5]),
      chainId: "test-1",
      accountNumber: 7n,
    });
    expect(hex(bytes)).toBe("0a03010203120204051a06746573742d312007");
  });

  it("writes multi-byte varints and omits proto3 defaults", () => {
    const withBigAccount = encodeDirectSignDoc({
      bodyBytes: Uint8Array.from([1]),
      authInfoBytes: new Uint8Array(),
      chainId: "c",
      accountNumber: 300n,
    });
    expect(hex(withBigAccount)).toBe("0a01011a016320ac02");

    const zeroAccount = encodeDirectSignDoc({
      bodyBytes: Uint8Array.from([1]),
      authInfoBytes: new Uint8Array(),
      chainId: "c",
      accountNumber: 0n,
    });
    expect(hex(zeroAccount)).toBe("0a01011a0163");
  });
});

describe("bytesFromWire", () => {
  it("accepts every shape a page can send", () => {
    const expected = [1, 2, 3];
    expect(Array.from(bytesFromWire(Uint8Array.from(expected), "x"))).toEqual(expected);
    expect(Array.from(bytesFromWire(expected, "x"))).toEqual(expected);
    expect(Array.from(bytesFromWire({ 0: 1, 1: 2, 2: 3 }, "x"))).toEqual(expected);
    expect(Array.from(bytesFromWire("AQID", "x"))).toEqual(expected);
    expect(Array.from(bytesFromWire("0x010203", "x"))).toEqual(expected);
  });

  it("reads unprefixed strings as base64, never as hex", () => {
    expect(Array.from(bytesFromWire("0102", "x"))).toEqual([0xd3, 0x5d, 0x36]);
  });

  it("refuses values that are not bytes", () => {
    expect(() => bytesFromWire([1, 256], "x")).toThrow(/not a byte array/);
    expect(() => bytesFromWire([1, -1], "x")).toThrow(/not a byte array/);
    expect(() => bytesFromWire([1.5], "x")).toThrow(/not a byte array/);
    expect(() => bytesFromWire({ 0: 1, 2: 3 }, "x")).toThrow(/not a byte array/);
    expect(() => bytesFromWire("0x0g", "x")).toThrow(/not valid hex/);
    expect(() => bytesFromWire("not base64!", "x")).toThrow(/not hex or base64/);
    expect(() => bytesFromWire(undefined, "x")).toThrow(/missing/);
  });
});

describe("u64FromWire", () => {
  it("reads bigint, number, decimal string, and Long", () => {
    expect(u64FromWire(5n, "n")).toBe(5n);
    expect(u64FromWire(5, "n")).toBe(5n);
    expect(u64FromWire("18446744073709551615", "n")).toBe(18446744073709551615n);
    expect(u64FromWire({ low: 1, high: 1 }, "n")).toBe(4294967297n);
    expect(u64FromWire(undefined, "n")).toBe(0n);
  });

  it("refuses negatives, fractions, and overflow", () => {
    expect(() => u64FromWire(-1, "n")).toThrow();
    expect(() => u64FromWire(1.5, "n")).toThrow();
    expect(() => u64FromWire(Number.MAX_SAFE_INTEGER + 2, "n")).toThrow();
    expect(() => u64FromWire("18446744073709551616", "n")).toThrow(/out of range/);
    expect(() => u64FromWire("-3", "n")).toThrow();
  });
});

describe("normalizeDirectSignDoc", () => {
  it("round-trips through the wire shape", () => {
    const doc = normalizeDirectSignDoc({
      bodyBytes: { 0: 9, 1: 8 },
      authInfoBytes: [7],
      chainId: "osmosis-1",
      accountNumber: "42",
    });
    expect(directSignDocToWire(doc)).toEqual({
      bodyBytes: [9, 8],
      authInfoBytes: [7],
      chainId: "osmosis-1",
      accountNumber: "42",
    });
  });

  it("requires a chain id and a body", () => {
    expect(() => normalizeDirectSignDoc({ bodyBytes: [1] })).toThrow(/chainId/);
    expect(() =>
      normalizeDirectSignDoc({ bodyBytes: [], chainId: "a", authInfoBytes: [] }),
    ).toThrow(/empty/);
  });
});

describe("chain and signer checks", () => {
  it("refuses a document for another chain", () => {
    expect(() => assertSameChain("cosmoshub-4", "cosmoshub-4")).not.toThrow();
    expect(() => assertSameChain("cosmoshub-4", "osmosis-1")).toThrow(
      /for osmosis-1, not cosmoshub-4/,
    );
  });

  it("refuses a signer that is not the active account", () => {
    expect(() => assertSigner("cosmos1abc", "cosmos1abc")).not.toThrow();
    expect(() => assertSigner("cosmos1xyz", "cosmos1abc")).toThrow(/active account/);
    expect(() => assertSigner(undefined, "cosmos1abc")).toThrow();
  });

  it("reads the amino chain id and requires msgs", () => {
    expect(aminoSignDocChainId({ chain_id: "juno-1", msgs: [] })).toBe("juno-1");
    expect(() => aminoSignDocChainId({ chain_id: "juno-1" })).toThrow(/msgs/);
    expect(() => aminoSignDocChainId({ msgs: [] })).toThrow(/chain_id/);
  });
});

describe("custom chain drafts", () => {
  const good: CustomChainDraft = {
    chainName: "Test Net",
    chainId: "zunia-test-1",
    rpc: "https://rpc.example.org/",
    rest: "https://rest.example.org//",
    bech32Prefix: "ztest",
    coinType: 118,
    coinDenom: "ZT",
    coinMinimalDenom: "uzt",
    coinDecimals: 6,
    gasPrice: 0.025,
  };

  it("normalizes a valid draft", () => {
    const clean = validateCustomChainDraft(good);
    expect(clean.rpc).toBe("https://rpc.example.org");
    expect(clean.rest).toBe("https://rest.example.org");
  });

  it("refuses unsafe endpoints", () => {
    expect(() => cleanEndpoint("http://rpc.example.org", "RPC")).toThrow(/https/);
    expect(() => cleanEndpoint("https://user:pw@rpc.example.org", "RPC")).toThrow(
      /username or password/,
    );
    expect(() => cleanEndpoint("javascript:alert(1)", "RPC")).toThrow(ChainDraftError);
  });

  it("refuses registry ids, bad prefixes, and hidden characters", () => {
    expect(() => validateCustomChainDraft({ ...good, chainId: "cosmoshub-4" })).toThrow(
      /already in the registry/,
    );
    expect(() => validateCustomChainDraft({ ...good, bech32Prefix: "Cosmos" })).toThrow(
      /Prefix/,
    );
    expect(() =>
      validateCustomChainDraft({ ...good, chainName: "Osmosis\u202e" }),
    ).toThrow(/hidden or control/);
    expect(() => validateCustomChainDraft({ ...good, coinDecimals: 19 })).toThrow(
      /Decimals/,
    );
  });

  it("reads a Keplr ChainInfo suggested by a dApp", () => {
    const draft = draftFromSuggestedChain({
      chainId: "zunia-test-2",
      chainName: "Zunia Test",
      rpc: "https://rpc.example.org",
      rest: "https://rest.example.org",
      bip44: { coinType: 118 },
      bech32Config: { bech32PrefixAccAddr: "ztest" },
      currencies: [{ coinDenom: "ZT", coinMinimalDenom: "uzt", coinDecimals: 6 }],
      feeCurrencies: [
        { coinDenom: "ZT", coinMinimalDenom: "uzt", coinDecimals: 6, gasPriceStep: { average: 0.03 } },
      ],
    });
    expect(draft).toMatchObject({
      chainId: "zunia-test-2",
      bech32Prefix: "ztest",
      coinType: 118,
      coinMinimalDenom: "uzt",
      gasPrice: 0.03,
    });
  });
});

describe("assessOrigin", () => {
  it("stays quiet for the real sites and their subdomains", () => {
    expect(assessOrigin("https://app.osmosis.zone").warnings).toEqual([]);
    expect(assessOrigin("https://app.osmosis.zone").level).toBe("none");
    expect(assessOrigin("https://wallet.keplr.app").warnings).toEqual([]);
    expect(assessOrigin("https://example.com").warnings).toEqual([]);
  });

  it("flags lookalikes, punycode, raw IPs, and plain http", () => {
    expect(assessOrigin("https://osmosls.zone").warnings.join(" ")).toMatch(/osmosis\.zone/);
    expect(assessOrigin("https://osmosls.zone").level).toBe("suspicious");
    expect(assessOrigin("https://keplr-rewards.io").warnings.join(" ")).toMatch(/keplr\.app/);
    expect(assessOrigin("https://xn--osmsis-8ya.zone").warnings.join(" ")).toMatch(
      /international characters/,
    );
    expect(assessOrigin("https://203.0.113.9").warnings.join(" ")).toMatch(/raw IP/);
    expect(assessOrigin("http://example.com").warnings.join(" ")).toMatch(/not encrypted/);
  });

  it("gives localhost one note, not a warning pile", () => {
    expect(assessOrigin("http://localhost:3000").warnings).toHaveLength(1);
    expect(assessOrigin("http://localhost:3000").level).toBe("local");
  });
});

describe("password throttle", () => {
  it("backs off exponentially after the free attempts, up to five minutes", () => {
    expect(throttleDelayMs(1)).toBe(0);
    expect(throttleDelayMs(2)).toBe(0);
    expect(throttleDelayMs(3)).toBe(2_000);
    expect(throttleDelayMs(4)).toBe(4_000);
    expect(throttleDelayMs(40)).toBe(300_000);
  });

  it("refuses attempts while the wait is in force", () => {
    let state = EMPTY_THROTTLE;
    for (let i = 0; i < 3; i++) state = recordFailure(state, 1_000);
    expect(state).toEqual({ failures: 3, retryAt: 3_000 });
    expect(() => assertNotThrottled(state, 2_000)).toThrow(PasswordThrottledError);
    expect(() => assertNotThrottled(state, 3_000)).not.toThrow();
  });

  it("reads stored state defensively and caps a wait stretched by a clock change", () => {
    expect(readThrottleState(null, 0)).toEqual(EMPTY_THROTTLE);
    expect(readThrottleState({ failures: "9", retryAt: -1 }, 0)).toEqual(EMPTY_THROTTLE);
    expect(readThrottleState({ failures: 5, retryAt: 500 }, 1_000)).toEqual({
      failures: 5,
      retryAt: 0,
    });
    expect(readThrottleState({ failures: 9, retryAt: 10 ** 12 }, 1_000).retryAt).toBe(
      1_000 + 300_000,
    );
  });
});

describe("sender policy", () => {
  const ctx: SenderContext = {
    extensionId: "ext",
    extensionBaseUrl: "chrome-extension://ext/",
    external: false,
  };

  it("classifies who is speaking", () => {
    expect(classifySender({ id: "ext", url: "chrome-extension://ext/popup.html" }, ctx)).toBe(
      "extension-page",
    );
    expect(
      classifySender(
        { id: "ext", url: "chrome-extension://ext/connect.html?id=1", tab: { id: 3 } },
        ctx,
      ),
    ).toBe("connect-frame");
    expect(classifySender({ id: "ext", url: "https://dapp.example/", tab: { id: 3 } }, ctx)).toBe(
      "content-script",
    );
    expect(classifySender({ id: "other", url: "chrome-extension://ext/popup.html" }, ctx)).toBe(
      "unknown",
    );
    expect(classifySender({ id: "ext" }, { ...ctx, external: true })).toBe("external");
  });

  it("keeps content scripts and external pages away from the wallet", () => {
    expect(messageAllowed("content-script", "PROVIDER_REQUEST")).toBe(true);
    expect(messageAllowed("content-script", "PING")).toBe(true);
    expect(messageAllowed("content-script", "UNLOCK")).toBe(false);
    expect(messageAllowed("content-script", "REVEAL_MNEMONIC")).toBe(false);
    expect(messageAllowed("connect-frame", "RESOLVE_APPROVAL")).toBe(true);
    expect(messageAllowed("connect-frame", "SIGN_AND_BROADCAST")).toBe(false);
    expect(messageAllowed("external", "GET_STATUS")).toBe(true);
    expect(messageAllowed("external", "LIST_PERMISSIONS")).toBe(false);
    expect(messageAllowed("extension-page", "UNLOCK")).toBe(true);
    expect(messageAllowed("extension-page", "PROVIDER_REQUEST")).toBe(false);
    expect(messageAllowed("unknown", "PING")).toBe(false);
  });

  it("takes the provider origin from the browser, not the message", () => {
    expect(providerOriginFromSender({ origin: "https://dapp.example" })).toBe(
      "https://dapp.example",
    );
    expect(providerOriginFromSender({ url: "https://dapp.example/path?q=1" })).toBe(
      "https://dapp.example",
    );
    expect(providerOriginFromSender({ origin: "null" })).toBeNull();
    expect(providerOriginFromSender({ url: "chrome-extension://ext/popup.html" })).toBeNull();
    expect(providerOriginFromSender({ url: "file:///etc/passwd" })).toBeNull();
  });
});

describe("approval lifecycle", () => {
  beforeEach(() => {
    resetApprovalsForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    resetApprovalsForTests();
    vi.useRealTimers();
  });

  const request = (tabId: number, origin = "https://a.test") => ({
    kind: "enable" as const,
    origin,
    chainIds: ["cosmoshub-4"],
    tabId,
    title: "Connect",
  });

  it("expires unanswered requests", async () => {
    const { result } = enqueueApprovalWithId(request(1));
    const settled = expect(result).rejects.toThrow(/expired/);
    vi.advanceTimersByTime(SECURITY_CONFIG.approvals.ttlMs);
    await settled;
    expect(getPendingApprovals()).toHaveLength(0);
  });

  it("merges connection requests from the same tab", async () => {
    const seen: number[] = [];
    onApprovalsChanged((pending) => seen.push(pending.length));
    const first = enqueueApprovalWithId(request(1));
    const joined = findPendingEnable("https://a.test", 1);
    expect(joined?.id).toBe(first.id);
    expect(findPendingEnable("https://a.test", 2)).toBeNull();
    expect(findPendingEnable("https://b.test", 1)).toBeNull();

    extendApprovalChains(first.id, ["osmosis-1", "cosmoshub-4"]);
    expect(getPendingApprovals()[0]?.chainIds).toEqual(["cosmoshub-4", "osmosis-1"]);

    setApprovalHost(first.id, "overlay");
    expect(getPendingApprovals()[0]?.host).toBe("overlay");
    expect(seen.length).toBeGreaterThanOrEqual(3);

    resolveApproval(first.id, { approved: true });
    await expect(joined!.result).resolves.toEqual({ approved: true });
  });

  it("rejects only what the predicate selects", async () => {
    const closed = enqueueApprovalWithId(request(1));
    const open = enqueueApprovalWithId(request(2, "https://b.test"));
    const rejected = expect(closed.result).rejects.toThrow("Tab closed");
    expect(rejectApprovalsWhere((item) => item.tabId === 1, "Tab closed")).toBe(1);
    await rejected;
    expect(getPendingApprovals().map((item) => item.id)).toEqual([open.id]);
  });
});
