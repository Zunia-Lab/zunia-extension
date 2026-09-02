import { describe, expect, it, beforeEach } from "vitest";
import {
  permissionLogic,
  type OriginGrant,
} from "../permissions";
import {
  enqueueApproval,
  pendingCount,
  rejectApproval,
  resetApprovalsForTests,
  resolveApproval,
  getPendingApprovals,
} from "../approvals";
import {
  isExternallyConnectableOrigin,
  matchOriginPattern,
} from "../messaging";
import { summarizeAminoMsgs } from "../signing";
import { createLocalKernel } from "../kernel";

describe("permissionLogic", () => {
  it("detects expired grants", () => {
    const grant: OriginGrant = {
      origin: "https://app.example",
      chainIds: ["cosmoshub-4"],
      createdAt: 0,
      expiresAt: 1000,
    };
    expect(permissionLogic.isGrantActive(grant, 999)).toBe(true);
    expect(permissionLogic.isGrantActive(grant, 1000)).toBe(false);
  });

  it("allows wildcard chain", () => {
    const grant: OriginGrant = {
      origin: "https://app.example",
      chainIds: ["*"],
      createdAt: 0,
      expiresAt: null,
    };
    expect(permissionLogic.grantAllowsChain(grant, "osmosis-1")).toBe(true);
  });

  it("merges chain ids uniquely", () => {
    expect(
      permissionLogic.mergeChains(["a", "b"], ["b", "c"]),
    ).toEqual(["a", "b", "c"]);
  });
});

describe("approval queue", () => {
  beforeEach(() => {
    resetApprovalsForTests();
  });

  it("caps pending approvals at 3", async () => {
    const p1 = enqueueApproval({
      kind: "enable",
      origin: "https://a.test",
      chainIds: ["cosmoshub-4"],
      title: "1",
    });
    const p2 = enqueueApproval({
      kind: "enable",
      origin: "https://b.test",
      chainIds: ["cosmoshub-4"],
      title: "2",
    });
    const p3 = enqueueApproval({
      kind: "enable",
      origin: "https://c.test",
      chainIds: ["cosmoshub-4"],
      title: "3",
    });
    expect(pendingCount()).toBe(3);
    await expect(
      enqueueApproval({
        kind: "enable",
        origin: "https://d.test",
        chainIds: ["cosmoshub-4"],
        title: "4",
      }),
    ).rejects.toThrow(/Too many pending/);

    const id = getPendingApprovals()[0]!.id;
    resolveApproval(id, { approved: true });
    await expect(p1).resolves.toEqual({ approved: true });
    rejectApproval(getPendingApprovals()[0]!.id);
    rejectApproval(getPendingApprovals()[0]!.id);
    await expect(p2).rejects.toThrow(/rejected/i);
    await expect(p3).rejects.toThrow(/rejected/i);
  });
});

describe("origin checks", () => {
  it("matches wildcard hosts", () => {
    expect(
      matchOriginPattern(
        "https://wallet.zuniawallet.com",
        "https://*.zuniawallet.com/*",
      ),
    ).toBe(true);
    expect(
      matchOriginPattern("https://evil.com", "https://*.zuniawallet.com/*"),
    ).toBe(false);
  });

  it("allows first-party and localhost", () => {
    expect(isExternallyConnectableOrigin("https://zuniawallet.com")).toBe(
      true,
    );
    expect(isExternallyConnectableOrigin("http://localhost:3000")).toBe(true);
    expect(isExternallyConnectableOrigin("https://phishing.example")).toBe(
      false,
    );
  });
});

describe("signing summaries", () => {
  it("summarizes MsgSend and flags unknown types", () => {
    const msgs = summarizeAminoMsgs([
      {
        type: "cosmos-sdk/MsgSend",
        value: {
          to_address: "cosmos1abc",
          amount: [{ amount: "1000", denom: "uatom" }],
        },
      },
      {
        type: "custom/Weird",
        value: {},
      },
    ]);
    expect(msgs[0]?.recipient).toBe("cosmos1abc");
    expect(msgs[0]?.summary).toContain("1000 uatom");
    expect(msgs[1]?.unknown).toBe(true);
  });
});

describe("local kernel", () => {
  const kernel = createLocalKernel();

  it("seals and opens a keyring", () => {
    const phrase = kernel.generateMnemonic(12);
    expect(kernel.validateMnemonic(phrase)).toBe(true);
    const envelope = kernel.sealKeyring(phrase, "password123", "{}");
    expect(kernel.openKeyring(envelope, "password123")).toBe(phrase);
    expect(() => kernel.openKeyring(envelope, "wrong")).toThrow(/password/i);
  });

  it("rejects mnemonics with a bad checksum", () => {
    expect(kernel.validateMnemonic("abandon ".repeat(12).trim())).toBe(false);
  });

  it("derives the canonical cosmos test vector", () => {
    const phrase = `${"abandon ".repeat(11)}about`;
    const derived = kernel.deriveAddress(
      phrase,
      "",
      JSON.stringify({ bech32Prefix: "cosmos", coinType: 118 }),
      0,
    );
    expect(derived.bech32Address).toBe(
      "cosmos19rl4cm2hmr8afy4kldpxz3fka4jguq0auqdal4",
    );
    expect(derived.path).toBe("m/44'/118'/0'/0/0");
    expect(derived.pubKey).toHaveLength(33);
  });

  it("re-prefixes the same key per chain", () => {
    const phrase = `${"abandon ".repeat(11)}about`;
    const osmo = kernel.deriveAddress(
      phrase,
      "",
      JSON.stringify({ bech32Prefix: "osmo", coinType: 118 }),
      0,
    );
    expect(osmo.bech32Address.startsWith("osmo1")).toBe(true);
    expect(osmo.bech32Address).not.toContain("qqqqqq");
  });

  it("produces a 64-byte compact signature", () => {
    const phrase = `${"abandon ".repeat(11)}about`;
    const sig = kernel.signCosmos(
      phrase,
      "",
      JSON.stringify({ bech32Prefix: "cosmos", coinType: 118 }),
      0,
      "deadbeef",
    );
    expect(sig).toHaveLength(128);
  });
});

describe("token classification", () => {
  it("labels native, ibc and factory denoms", async () => {
    const { classifyToken } = await import("../balances");
    const native = { denom: "uatom", symbol: "ATOM", decimals: 6 };
    expect(classifyToken("uatom", "100", native).kind).toBe("native");
    expect(classifyToken("uatom", "100", native).displayName).toBe("ATOM");
    expect(classifyToken("ibc/ABCDEF1234", "1", native).kind).toBe("ibc");
    expect(classifyToken("ibc/ABCDEF1234", "1", native).displayName).toContain(
      "IBC",
    );
    expect(
      classifyToken("factory/osmo1abc/usdc", "1", native).symbol,
    ).toBe("usdc");
    expect(classifyToken("factory/osmo1abc/usdc", "1", native).kind).toBe(
      "factory",
    );
  });
});
