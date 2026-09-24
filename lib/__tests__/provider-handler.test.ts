import { afterEach, describe, expect, it, vi } from "vitest";
import vectors from "./fixtures/sign-in-vectors.json";

const { SIGNER, openApprovalUi } = vi.hoisted(() => ({
  SIGNER: "cosmos1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu",
  openApprovalUi: vi.fn(async () => undefined),
}));

vi.mock("../approval-ui", () => ({
  approvalUiOpen: () => false,
  openApprovalUi,
}));

vi.mock("../kernel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../kernel")>();
  return {
    ...actual,
    loadKernel: async () => ({
      deriveAddress: () => ({
        address: "00",
        bech32Address: SIGNER,
        algo: "secp256k1",
        pubKey: new Uint8Array(33).fill(2),
      }),
      signCosmos: () => "11".repeat(64),
    }),
  };
});

import { getPendingApprovals, resetApprovalsForTests, resolveApproval } from "../approvals";
import { handleProviderRequest, type ProviderMethod } from "../provider-handler";
import { STORAGE_KEYS } from "../storage-keys";

const ORIGIN = "https://app.example.com";
const CHAIN = "cosmoshub-4";

function area(map: Map<string, unknown>) {
  return {
    get: async (keys?: string | string[] | null) => {
      const list = keys == null ? [...map.keys()] : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const key of list) if (map.has(key)) out[key] = map.get(key);
      return out;
    },
    set: async (patch: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(patch)) map.set(key, value);
    },
    remove: async (keys: string | string[]) => {
      for (const key of [keys].flat()) map.delete(key);
    },
  };
}

function installBrowser(options: { unlocked: boolean; grants: Record<string, string[]> }): void {
  const local = new Map<string, unknown>();
  const session = new Map<string, unknown>();
  const now = Date.now();
  local.set(
    STORAGE_KEYS.permissions,
    Object.fromEntries(
      Object.entries(options.grants).map(([origin, chainIds]) => [
        origin,
        { origin, chainIds, expiresAt: now + 60_000, createdAt: now, lastUsedAt: null, accounts: {} },
      ]),
    ),
  );
  local.set(STORAGE_KEYS.accounts, [
    { index: 0, name: "Main", address: SIGNER, algo: "secp256k1", pubKeyHex: "02".repeat(33) },
  ]);
  if (options.unlocked) {
    session.set(STORAGE_KEYS.sessionMnemonic, "test words");
    session.set(STORAGE_KEYS.sessionActiveAccount, 0);
  }
  vi.stubGlobal("browser", {
    storage: {
      local: area(local),
      session: area(session),
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    alarms: { create: vi.fn(async () => undefined), clear: vi.fn(async () => true) },
    tabs: { sendMessage: vi.fn(async () => undefined) },
  });
}

function call(method: ProviderMethod, args: unknown[] = [], origin = ORIGIN) {
  return handleProviderRequest({ origin, method, args });
}

/** The minimal vector, issued now so the wallet clock accepts it. */
function freshSignIn(edit: (lines: string[]) => string[] = (lines) => lines): string {
  const lines = vectors.valid[0]!.lines.map((line) =>
    line.startsWith("Issued At: ") ? `Issued At: ${new Date().toISOString()}` : line,
  );
  return edit(lines).join("\n");
}

afterEach(() => {
  resetApprovalsForTests();
  openApprovalUi.mockClear();
  vi.unstubAllGlobals();
});

describe("session restore", () => {
  it("lists the caller's chains without unlocking or opening anything", async () => {
    installBrowser({
      unlocked: false,
      grants: { [ORIGIN]: [CHAIN], "https://other.example": ["osmosis-1"] },
    });
    await expect(call("getConnectedChains")).resolves.toEqual([CHAIN]);
    await expect(call("getConnectedChains", [], "https://stranger.example")).resolves.toEqual([]);
    expect(openApprovalUi).not.toHaveBeenCalled();
  });

  it("tells only a connected site whether the wallet is locked", async () => {
    installBrowser({ unlocked: false, grants: { [ORIGIN]: [CHAIN] } });
    await expect(call("isLocked")).resolves.toBe(true);
    await expect(call("isLocked", [], "https://stranger.example")).rejects.toMatchObject({
      code: "NOT_CONNECTED",
    });
  });
});

describe("error codes", () => {
  it("names what went wrong", async () => {
    installBrowser({ unlocked: true, grants: { [ORIGIN]: [CHAIN] } });
    await expect(call("getKey", ["osmosis-1"])).rejects.toMatchObject({
      code: "NOT_CONNECTED",
      message: "Not authorized",
    });
    await expect(call("getKey", [""])).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    await expect(call("enable", ["no-such-chain-9"])).rejects.toMatchObject({
      code: "UNKNOWN_CHAIN",
    });
    await expect(call("sendTx", [CHAIN, {}, "sync"])).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(call("signDirect", [CHAIN, SIGNER, { chainId: CHAIN }])).rejects.toMatchObject({
      code: "INVALID_PARAMS",
    });
    await expect(call("nope" as ProviderMethod)).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });
});

describe("sign-in", () => {
  it("refuses another site's sign-in before any window opens, even while locked", async () => {
    installBrowser({ unlocked: false, grants: { "https://evil.example": [CHAIN] } });
    await expect(
      call("signArbitrary", [CHAIN, SIGNER, freshSignIn()], "https://evil.example"),
    ).rejects.toMatchObject({ code: "ORIGIN_MISMATCH" });
    expect(openApprovalUi).not.toHaveBeenCalled();
    expect(getPendingApprovals()).toEqual([]);
  });

  it("refuses a sign-in that bends the format", async () => {
    installBrowser({ unlocked: true, grants: { [ORIGIN]: [CHAIN] } });
    const crlf = freshSignIn().replaceAll("\n", "\r\n");
    await expect(call("signArbitrary", [CHAIN, SIGNER, crlf])).rejects.toMatchObject({
      code: "INVALID_PARAMS",
    });
    const bytes = [...new TextEncoder().encode(freshSignIn()), 0xff];
    await expect(call("signArbitrary", [CHAIN, SIGNER, bytes])).rejects.toMatchObject({
      code: "INVALID_PARAMS",
    });
    expect(getPendingApprovals()).toEqual([]);
  });

  it("asks to sign in to the site, then returns an ADR-36 signature", async () => {
    installBrowser({ unlocked: true, grants: { [ORIGIN]: [CHAIN] } });
    const message = freshSignIn();
    const pending = call("signArbitrary", [CHAIN, SIGNER, message]);
    await vi.waitFor(() => expect(getPendingApprovals()).toHaveLength(1));
    const [approval] = getPendingApprovals();
    expect(approval!.title).toBe("Sign in to app.example.com");
    expect(approval!.detail).toMatchObject({
      signIn: { domain: "app.example.com", chainId: CHAIN, address: SIGNER },
      message,
    });
    resolveApproval(approval!.id, { approved: true });
    await expect(pending).resolves.toMatchObject({
      signed: { msgs: [{ type: "sign/MsgSignData" }] },
      signature: { pub_key: { type: "tendermint/PubKeySecp256k1" } },
    });
  });

  it("leaves a plain message a plain message", async () => {
    installBrowser({ unlocked: true, grants: { [ORIGIN]: [CHAIN] } });
    const pending = call("signArbitrary", [CHAIN, SIGNER, "Hello from Zunia"]);
    await vi.waitFor(() => expect(getPendingApprovals()).toHaveLength(1));
    const [approval] = getPendingApprovals();
    expect(approval!.title).toBe(`Sign message on ${CHAIN}`);
    expect(approval!.detail).not.toHaveProperty("signIn");
    resolveApproval(approval!.id, { approved: false });
    await expect(pending).rejects.toMatchObject({ code: "USER_REJECTED", message: "Request rejected" });
  });
});
