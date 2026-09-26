import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  addUserContract,
  clearNftScanCache,
  discoverCollections,
} from "../nft";
import { clearInterchainCaches } from "../interchain";

/**
 * How a chain's CW721 collections are found, and what is *not* said about the
 * contracts that are not collections.
 *
 * The bug this file pins: discovery used to list every contract the chain had
 * ever instantiated and send each one a CW721 `tokens` query. On a real network
 * most contracts are pools, hooks and multisigs, every one of them answered
 * HTTP 400, and the screen rendered fifty red rows telling the user that
 * Osmosis runs contracts which are not NFT collections. Nothing on that list
 * was actionable and the real answer was buried under it.
 *
 * Contracts instantiated from one wasm code all run the same bytecode, so
 * "does this answer `tokens`?" is a question about the code. These tests pin
 * that it is asked once per code, that the answer is remembered - wasm code is
 * immutable, so it cannot stop being true - and that a code which is not a
 * CW721 produces no user-facing failure at all.
 */

const CHAIN = "safrochain-1";
const REST = "https://api.safrochain.network";
const OWNER = "addr_safro1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqowner";

/** Code 7: a real CW721 with two instances. */
const NFT_A = "addr_safro1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqnfta";
const NFT_B = "addr_safro1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqnftb";
/** Code 5: three instances of something that is not a CW721 at all. */
const POOLS = [
  "addr_safro1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqpool1",
  "addr_safro1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqpool2",
  "addr_safro1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqpool3",
];
/** Code 2: one more non-CW721. */
const HOOK = "addr_safro1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhook";

const CONTRACTS_BY_CODE: Record<string, string[]> = {
  "7": [NFT_A, NFT_B],
  "5": POOLS,
  "2": [HOOK],
};

function queryFrom(url: string): Record<string, unknown> | null {
  const marker = "/smart/";
  const at = url.indexOf(marker);
  if (at < 0) return null;
  const encoded = url.slice(at + marker.length).replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Record<
    string,
    unknown
  >;
}

/** The contract address out of a `/contract/{addr}/smart/...` path. */
function contractFrom(url: string): string {
  return decodeURIComponent(url.split("/contract/")[1]?.split("/")[0] ?? "");
}

function json(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** wasmd's answer to a query a contract cannot parse: 400 with a serde error. */
function rejected(): Response {
  return {
    ok: false,
    status: 400,
    headers: { get: () => null },
    text: async () => '{"message":"unknown variant `tokens`"}',
  } as unknown as Response;
}

let requested: string[] = [];

function installFetch(): void {
  requested = [];
  vi.stubGlobal("fetch", async (input: string): Promise<Response> => {
    requested.push(input);
    if (!input.startsWith(REST)) throw new Error(`unexpected host ${input}`);

    // The nft module, in two pages, so the walk has to follow `next_key`.
    if (input.includes("/cosmos/nft/v1beta1/nfts?")) {
      const page = new URL(input).searchParams.get("pagination.key");
      return page === null
        ? json({
            nfts: [{ class_id: "zunia:badges", id: "1" }],
            pagination: { next_key: "page2" },
          })
        : json({
            nfts: [{ class_id: "zunia:badges", id: "2" }],
            pagination: { next_key: "" },
          });
    }
    if (input.includes("/cosmos/nft/v1beta1/classes/")) {
      return json({ class: { id: "zunia:badges", name: "Zunia Badges" } });
    }

    // The wasm code list, newest first.
    if (/\/cosmwasm\/wasm\/v1\/code\?/.test(input)) {
      return json({
        code_infos: [{ code_id: "7" }, { code_id: "5" }, { code_id: "2" }],
        pagination: { total: "11" },
      });
    }
    const byCode = /\/cosmwasm\/wasm\/v1\/code\/(\d+)\/contracts/.exec(input);
    if (byCode) {
      return json({ contracts: CONTRACTS_BY_CODE[byCode[1]!] ?? [], pagination: {} });
    }

    const query = queryFrom(input);
    if (!query) throw new Error(`unexpected LCD path ${input}`);
    const contract = contractFrom(input);
    const isCw721 = contract === NFT_A || contract === NFT_B;
    if (!isCw721) return rejected();

    if ("tokens" in query) {
      return json({ data: { tokens: contract === NFT_A ? ["1"] : [] } });
    }
    if ("collection_info" in query) return rejected();
    if ("contract_info" in query) {
      return json({ data: { name: "Safro Originals", symbol: "SAFRO" } });
    }
    if ("num_tokens" in query) return json({ data: { count: 2 } });
    throw new Error(`unstubbed query ${JSON.stringify(query)}`);
  });
}

function installBrowser(): void {
  const store = new Map<string, unknown>();
  store.set("zunia.settings", { liveBalances: true, nftAutoScan: true });
  vi.stubGlobal("browser", {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: store.get(key) }),
        set: async (patch: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(patch)) store.set(k, v);
        },
        remove: async (key: string) => void store.delete(key),
      },
    },
    permissions: { contains: async () => true },
  });
}

/** `tokens` smart queries sent to one contract in this run. */
function tokenQueriesTo(address: string): number {
  return requested.filter(
    (url) => contractFrom(url) === address && queryFrom(url)?.["tokens"] !== undefined,
  ).length;
}

beforeEach(() => {
  installBrowser();
  installFetch();
  clearInterchainCaches();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearInterchainCaches();
});

describe("the CW721 code scan", () => {
  it("asks one instance per wasm code instead of every contract on the chain", async () => {
    const result = await discoverCollections(CHAIN, OWNER);

    // Code 5 has three instances. Exactly one of them was asked: the answer
    // came back "not a CW721", which settles the other two for free.
    expect(tokenQueriesTo(POOLS[0]!)).toBe(1);
    expect(tokenQueriesTo(POOLS[1]!)).toBe(0);
    expect(tokenQueriesTo(POOLS[2]!)).toBe(0);
    expect(tokenQueriesTo(HOOK)).toBe(1);
    expect(result.scan.codesScanned).toBe(3);
    expect(result.scan.cw721Codes).toBe(1);
    expect(result.scan.codesTotal).toBe(11);
  });

  it("reports no failure for a contract that is simply not a collection", async () => {
    const result = await discoverCollections(CHAIN, OWNER);
    // The whole point: four rejections happened and none of them is something
    // the user is asked to look at.
    expect(result.issues).toEqual([]);
    expect(result.scan.notCw721).toBe(0);
  });

  it("finds the collections, from the nft module and from the scanned code", async () => {
    const result = await discoverCollections(CHAIN, OWNER);
    const byAddress = new Map(
      result.collections.map((row) => [row.contractAddress, row]),
    );

    // Both pages of the module walk landed, and the class is labelled as coming
    // from the chain itself rather than from an index.
    const module_ = byAddress.get("zunia:badges");
    expect(module_?.tokenIds).toEqual(["1", "2"]);
    expect(module_?.source).toBe("module");
    expect(module_?.info?.name).toBe("Zunia Badges");
    expect(result.scan.moduleAnswered).toBe(true);
    expect(result.scan.moduleComplete).toBe(true);
    expect(result.scan.moduleClasses).toBe(1);

    expect(byAddress.get(NFT_A)?.tokenIds).toEqual(["1"]);
    // The owner holds nothing in the other instance of the same code, so it is
    // not a collection of theirs and is not listed.
    expect(byAddress.has(NFT_B)).toBe(false);
  });

  it("never claims a CosmWasm list is complete", async () => {
    const result = await discoverCollections(CHAIN, OWNER);
    expect(result.complete).toBe(false);
    expect(result.limitation).not.toBeNull();
    expect(result.scan.queriedNothing).toBe(false);
  });

  it("remembers the verdicts, so a second run re-lists nothing", async () => {
    await discoverCollections(CHAIN, OWNER);
    installFetch();

    const result = await discoverCollections(CHAIN, OWNER);
    expect(result.scan.fromCache).toBe(true);
    // No code list, no per-code contract list, and not one probe of a contract
    // already known not to be a collection.
    expect(requested.some((url) => /\/cosmwasm\/wasm\/v1\/code\?/.test(url))).toBe(false);
    expect(requested.some((url) => /\/code\/\d+\/contracts/.test(url))).toBe(false);
    expect(tokenQueriesTo(POOLS[0]!)).toBe(0);
    // The collections still come back: the cached list is the CW721 contracts.
    expect(result.collections.map((row) => row.contractAddress)).toContain(NFT_A);
    expect(result.scan.cw721Codes).toBe(1);
  });

  it("re-lists the chain when the user asks for a reload", async () => {
    await discoverCollections(CHAIN, OWNER);
    installFetch();

    const result = await discoverCollections(CHAIN, OWNER, { force: true });
    expect(result.scan.fromCache).toBe(false);
    expect(requested.some((url) => /\/cosmwasm\/wasm\/v1\/code\?/.test(url))).toBe(true);
    // The verdicts survive the reload, so the codes that are not collections
    // are re-listed but never re-probed.
    expect(tokenQueriesTo(POOLS[0]!)).toBe(0);
  });

  it("re-probes every code once the stored verdicts are dropped", async () => {
    await discoverCollections(CHAIN, OWNER);
    await clearNftScanCache();
    installFetch();

    const result = await discoverCollections(CHAIN, OWNER);
    expect(tokenQueriesTo(POOLS[0]!)).toBe(1);
    expect(result.scan.cw721Codes).toBe(1);
  });

  it("scans nothing when the user turned automatic scanning off", async () => {
    await browser.storage.local.set({
      "zunia.settings": { liveBalances: true, nftAutoScan: false },
    });
    const result = await discoverCollections(CHAIN, OWNER);
    expect(result.scan.scanSkipped).toBe("preference");
    expect(requested.some((url) => url.includes("/cosmwasm/wasm/v1/code"))).toBe(false);
    // The nft module is still asked: it is one request and it is authoritative.
    expect(result.scan.moduleAnswered).toBe(true);
    expect(result.collections.map((row) => row.contractAddress)).toEqual([
      "zunia:badges",
    ]);
  });

  it("says nothing at all about a chain that does not run the nft module", async () => {
    // A gRPC gateway with no `x/nft` registered answers 400, 404 or 501. None of
    // them is a failure the user can act on, and most Cosmos chains answer one
    // of them, so none may reach the screen.
    for (const status of [400, 404, 501]) {
      installFetch();
      const inner = globalThis.fetch;
      vi.stubGlobal("fetch", async (input: string): Promise<Response> => {
        if (input.includes("/cosmos/nft/v1beta1/")) {
          requested.push(input);
          return {
            ok: false,
            status,
            headers: { get: () => null },
            text: async () => '{"code":12,"message":"Not Implemented"}',
          } as unknown as Response;
        }
        return inner(input) as Promise<Response>;
      });
      clearInterchainCaches();
      await clearNftScanCache();

      const result = await discoverCollections(CHAIN, OWNER);
      expect(result.scan.moduleAnswered).toBe(false);
      expect(result.issues).toEqual([]);
      // The CW721 side still ran and still found the collection.
      expect(result.collections.map((row) => row.contractAddress)).toEqual([NFT_A]);
    }
  });

  it("does report a contract the user asked about by name", async () => {
    await browser.storage.local.set({
      "zunia.settings": { liveBalances: true, nftAutoScan: false },
    });
    await addUserContract(CHAIN, POOLS[0]!);

    const result = await discoverCollections(CHAIN, OWNER);
    // A scanned address rejecting `tokens` is noise; an address the user typed
    // rejecting it is the answer to their question, and has to be shown.
    expect(result.scan.user).toBe(1);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.contractAddress).toBe(POOLS[0]);
    expect(result.issues[0]?.message).toContain("tokens");
  });
});
