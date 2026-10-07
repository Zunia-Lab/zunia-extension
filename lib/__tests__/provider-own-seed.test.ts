/**
 * A second recovery phrase added to the wallet (an "own seed" account at
 * index 1 or more) shows its address at derivation index 0 of that phrase.
 * Every dApp signature must come from that same key, or the site receives a
 * signature that does not verify against the public key it was given.
 *
 * Real JS kernel (keys and secp256k1), no network, no wasm.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../approval-ui", () => ({ approvalUiOpen: () => false, openApprovalUi: vi.fn(async () => undefined) }));

import { getPendingApprovals, resetApprovalsForTests, resolveApproval } from "../approvals";
import { createLocalKernel, fromBase64, resetKernelForTests, serializeAminoSignDoc, verifyAdr36 } from "../kernel";
import { handleProviderRequest } from "../provider-handler";
import { STORAGE_KEYS } from "../storage-keys";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";

const ORIGIN = "https://app.example.com";
const CHAIN = "cosmoshub-4";
const PRIMARY = `${"abandon ".repeat(11)}about`;
const SECOND = "legal winner thank year wave sausage worth useful legal winner thank yellow";

const kernel = createLocalKernel();
const chainJson = JSON.stringify({ bech32Prefix: "cosmos", coinType: 118 });
const primary0 = kernel.deriveAddress(PRIMARY, "", chainJson, 0);
const second0 = kernel.deriveAddress(SECOND, "", chainJson, 0);

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

/** Two phrases, the second one active: what ADD_ACCOUNT_SEED leaves behind. */
function installBrowser(): void {
  const now = Date.now();
  const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
  vi.stubGlobal("browser", {
    storage: {
      local: area(
        new Map<string, unknown>([
          [STORAGE_KEYS.permissions, { [ORIGIN]: { origin: ORIGIN, chainIds: [CHAIN], expiresAt: now + 60_000, createdAt: now, lastUsedAt: null, accounts: {} } }],
          [
            STORAGE_KEYS.accounts,
            [
              { index: 0, name: "Main", address: primary0.bech32Address, algo: "secp256k1", pubKeyHex: hex(primary0.pubKey), ownSeed: true },
              { index: 1, name: "Imported", address: second0.bech32Address, algo: "secp256k1", pubKeyHex: hex(second0.pubKey), ownSeed: true },
            ],
          ],
        ]),
      ),
      session: area(
        new Map<string, unknown>([
          [STORAGE_KEYS.sessionMnemonic, SECOND],
          [STORAGE_KEYS.sessionActiveAccount, 1],
        ]),
      ),
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    alarms: { create: vi.fn(async () => undefined), clear: vi.fn(async () => true) },
    tabs: { sendMessage: vi.fn(async () => undefined) },
  });
}

async function approveNext<T>(pending: Promise<unknown>): Promise<T> {
  await vi.waitFor(() => expect(getPendingApprovals()).toHaveLength(1));
  resolveApproval(getPendingApprovals()[0]!.id, { approved: true });
  return (await pending) as T;
}

type StdSignature = { pub_key: { type: string; value: string }; signature: string };

afterEach(() => {
  resetApprovalsForTests();
  vi.unstubAllGlobals();
});

describe("an imported phrase's account signs with the key it shows", () => {
  it("getKey reports the second phrase's index-0 key", async () => {
    resetKernelForTests();
    installBrowser();
    const key = (await handleProviderRequest({ origin: ORIGIN, method: "getKey", args: [CHAIN] })) as { bech32Address: string };
    expect(key.bech32Address).toBe(second0.bech32Address);
  }, 20_000);

  it("signArbitrary (sign-in) verifies against that key", async () => {
    resetKernelForTests();
    installBrowser();
    const data = "Hello from Zunia";
    const sig = await approveNext<StdSignature>(
      handleProviderRequest({ origin: ORIGIN, method: "signArbitrary", args: [CHAIN, second0.bech32Address, data] }),
    );
    expect(sig.pub_key.value).toBe(Buffer.from(second0.pubKey).toString("base64"));
    expect(verifyAdr36(second0.bech32Address, new TextEncoder().encode(data), second0.pubKey, fromBase64(sig.signature))).toBe(true);
  }, 20_000);

  it("signAmino verifies against that key", async () => {
    resetKernelForTests();
    installBrowser();
    const doc = {
      chain_id: CHAIN,
      account_number: "1",
      sequence: "0",
      fee: { amount: [{ denom: "uatom", amount: "5000" }], gas: "200000" },
      memo: "",
      msgs: [{ type: "cosmos-sdk/MsgSend", value: { from_address: second0.bech32Address, to_address: primary0.bech32Address, amount: [{ denom: "uatom", amount: "1" }] } }],
    };
    const res = await approveNext<{ signed: typeof doc; signature: StdSignature }>(
      handleProviderRequest({ origin: ORIGIN, method: "signAmino", args: [CHAIN, second0.bech32Address, doc] }),
    );
    const ok = secp256k1.verify(fromBase64(res.signature.signature), sha256(serializeAminoSignDoc(res.signed)), second0.pubKey, { prehash: false });
    expect(ok).toBe(true);
  }, 20_000);
});
