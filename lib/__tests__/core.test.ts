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
      lastUsedAt: null,
      accounts: {},
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
      lastUsedAt: null,
      accounts: {},
    };
    expect(permissionLogic.grantAllowsChain(grant, "osmosis-1")).toBe(true);
  });

  it("merges chain ids uniquely", () => {
    expect(
      permissionLogic.mergeChains(["a", "b"], ["b", "c"]),
    ).toEqual(["a", "b", "c"]);
  });

  it("reads grants saved before usage was tracked", () => {
    const grant = permissionLogic.normalizeGrant("https://app.example", {
      origin: "https://elsewhere.example",
      chainIds: ["cosmoshub-4", 7],
      createdAt: 5,
      expiresAt: null,
    });
    expect(grant).toEqual({
      origin: "https://app.example",
      chainIds: ["cosmoshub-4"],
      createdAt: 5,
      expiresAt: null,
      lastUsedAt: null,
      accounts: {},
    });
    expect(permissionLogic.normalizeGrant("https://app.example", { chainIds: "all" })).toBeNull();
  });

  it("keeps only exposed accounts for chains still granted", () => {
    const grant = permissionLogic.normalizeGrant("https://app.example", {
      chainIds: ["osmosis-1"],
      createdAt: 0,
      expiresAt: null,
      accounts: { "osmosis-1": "osmo1abc", "cosmoshub-4": "cosmos1abc", "juno-1": 3 },
    });
    expect(grant?.accounts).toEqual({ "osmosis-1": "osmo1abc" });
  });

  describe("touchedGrant", () => {
    const base: OriginGrant = {
      origin: "https://app.example",
      chainIds: ["osmosis-1"],
      createdAt: 0,
      expiresAt: null,
      lastUsedAt: 100_000,
      accounts: { "osmosis-1": "osmo1abc" },
    };

    it("skips the write for a use within the last minute", () => {
      expect(permissionLogic.touchedGrant(base, 130_000)).toBeNull();
      expect(
        permissionLogic.touchedGrant(base, 130_000, { chainId: "osmosis-1", address: "osmo1abc" }),
      ).toBeNull();
    });

    it("records a use after a minute", () => {
      expect(permissionLogic.touchedGrant(base, 160_000)?.lastUsedAt).toBe(160_000);
    });

    it("records a new address at once", () => {
      const next = permissionLogic.touchedGrant(base, 101_000, {
        chainId: "osmosis-1",
        address: "osmo1new",
      });
      expect(next?.accounts).toEqual({ "osmosis-1": "osmo1new" });
      expect(next?.lastUsedAt).toBe(101_000);
    });

    it("ignores an address for a chain the site was not granted", () => {
      expect(
        permissionLogic.touchedGrant(base, 101_000, { chainId: "juno-1", address: "juno1abc" }),
      ).toBeNull();
    });
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
        "https://wallet.zunialab.com",
        "https://*.zunialab.com/*",
      ),
    ).toBe(true);
    expect(
      matchOriginPattern("https://evil.com", "https://*.zunialab.com/*"),
    ).toBe(false);
  });

  it("allows first-party and localhost", () => {
    expect(isExternallyConnectableOrigin("https://zunialab.com")).toBe(
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
  }, 20_000);

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

  it("derives ethermint (coin type 60) without treating the pubkey as a scalar", () => {
    const phrase = `${"abandon ".repeat(11)}about`;
    const inj = kernel.deriveAddress(
      phrase,
      "",
      JSON.stringify({ bech32Prefix: "inj", coinType: 60 }),
      0,
    );
    expect(inj.algo).toBe("eth_secp256k1");
    expect(inj.path).toBe("m/44'/60'/0'/0/0");
    expect(inj.bech32Address.startsWith("inj1")).toBe(true);
    expect(inj.pubKey).toHaveLength(33);
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

  it("reads ibc-go v9 denom traces so OSMO on Hub keeps its origin logo", async () => {
    const { parseDenomTrace } = await import("@zunialab/interchain");
    const trace = parseDenomTrace({
      denom: {
        base: "uosmo",
        trace: [{ port_id: "transfer", channel_id: "channel-141" }],
      },
    });
    expect(trace.baseDenom).toBe("uosmo");
    expect(trace.path).toBe("transfer/channel-141");
  });
});
