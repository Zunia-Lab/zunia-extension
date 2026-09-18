import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  addUserContract,
  discoverCollections,
  listUserContracts,
  loadToken,
  verifyNftBridge,
} from "../nft";
import { clearInterchainCaches } from "../interchain";

/**
 * The read path, end to end, against a stubbed transport.
 *
 * The message builders are pinned in `nft.test.ts`; this file pins everything
 * between the screen and the wire: the privacy gate, the base64url smart-query
 * path, the `{"data": …}` envelope, the three discovery inputs, and - the one
 * that matters most - the promise that nothing contacts a `token_uri` host
 * unless the user asked for it.
 *
 * The chain is `safrochain-1`, which is real: it is in the shipped catalog, it
 * declares `cosmwasm`, and its bech32 prefix is `addr_safro`, with an
 * underscore, which is the prefix most likely to break a naive address check.
 */

const CHAIN = "safrochain-1";
const REST = "https://api.safrochain.network";
const OWNER = "addr_safro1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqowner";
const COLLECTION = "addr_safro1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqcollection";
const TOKEN_URI = "ipfs://QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DYXkjGx/1.json";

/** Decode the query out of a `/smart/{base64url(json)}` path. */
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

function json(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    // `headers` is read by the metadata fetcher's size ceiling, not by the LCD
    // client. A stub without it would fail that path for the wrong reason.
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/**
 * How wasmd really answers a query a contract does not implement: HTTP 400
 * carrying a serde error, not a 404. The engine's two-spelling fallback keys
 * off exactly that, so the stub has to be faithful or the test proves nothing.
 */
function queryUnsupported(): Response {
  return {
    ok: false,
    status: 400,
    headers: { get: () => null },
    text: async () => '{"message":"unknown variant"}',
  } as unknown as Response;
}

/** Every URL the stub was asked for, in order. The privacy assertions read it. */
let requested: string[] = [];

function installFetch(options: { metadataBody?: unknown } = {}): void {
  requested = [];
  vi.stubGlobal("fetch", async (input: string): Promise<Response> => {
    requested.push(input);

    // Off-chain metadata host. Not an LCD path; only reached when the caller
    // opted in to reading `token_uri`.
    if (!input.startsWith(REST)) {
      if (options.metadataBody === undefined) {
        throw new Error(`unexpected off-chain request to ${input}`);
      }
      return json(options.metadataBody);
    }

    if (input.includes("/cosmwasm/wasm/v1/contract/") && !input.includes("/smart/")) {
      // The bridge existence check.
      return json({
        address: input.split("/contract/")[1],
        contract_info: { code_id: "12", label: "cw-ics721" },
      });
    }

    const query = queryFrom(input);
    if (!query) throw new Error(`unexpected LCD path ${input}`);

    if ("tokens" in query) return json({ data: { tokens: ["7", "8"] } });
    // An older cw721 that only answers `contract_info`.
    if ("collection_info" in query) return queryUnsupported();
    if ("contract_info" in query) {
      return json({ data: { name: "Safro Originals", symbol: "SAFRO" } });
    }
    if ("num_tokens" in query) return json({ data: { count: 250 } });
    if ("all_nft_info" in query) {
      return json({
        data: {
          access: { owner: OWNER, approvals: [] },
          info: {
            token_uri: TOKEN_URI,
            extension: {
              name: "On-chain name",
              attributes: [{ trait_type: "Rarity", value: "Rare" }],
            },
          },
        },
      });
    }
    throw new Error(`unstubbed query ${JSON.stringify(query)}`);
  });
}

/** A minimal `browser.*` so storage-backed helpers work outside the extension. */
function installBrowser(settings: { liveBalances: boolean }): void {
  const store = new Map<string, unknown>();
  store.set("zunia.settings", { liveBalances: settings.liveBalances });
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

beforeEach(() => {
  installBrowser({ liveBalances: true });
  installFetch();
  clearInterchainCaches();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearInterchainCaches();
});

describe("discoverCollections", () => {
  it("says nothing was queried when there is nothing to query", async () => {
    // This is the defect the mobile app shipped: an empty list rendered as
    // "you own no NFTs" after asking nobody. `queriedNothing` is what lets the
    // screen tell the two apart.
    const result = await discoverCollections(CHAIN, OWNER);
    expect(result.collections).toEqual([]);
    expect(result.scan.queriedNothing).toBe(true);
    expect(result.scan.known).toBe(0);
    expect(result.scan.user).toBe(0);
    expect(result.scan.indexer).toBeNull();
    expect(requested).toEqual([]);
  });

  it("reads a user-added contract and labels where it came from", async () => {
    await addUserContract(CHAIN, COLLECTION);
    expect(await listUserContracts(CHAIN)).toEqual([COLLECTION]);

    const result = await discoverCollections(CHAIN, OWNER);
    expect(result.scan.queriedNothing).toBe(false);
    expect(result.scan.user).toBe(1);
    expect(result.collections).toHaveLength(1);
    const collection = result.collections[0]!;
    expect(collection.contractAddress).toBe(COLLECTION);
    expect(collection.source).toBe("user");
    expect(collection.tokenIds).toEqual(["7", "8"]);
    // Falls back from `collection_info` to `contract_info` without failing.
    expect(collection.info?.name).toBe("Safro Originals");
    expect(collection.info?.tokenCount).toBe(250);
    expect(result.issues).toEqual([]);
  });

  it("never claims completeness from a contract scan", async () => {
    await addUserContract(CHAIN, COLLECTION);
    const result = await discoverCollections(CHAIN, OWNER);
    expect(result.complete).toBe(false);
    expect(result.limitation).not.toBeNull();
  });

  it("refuses an address from another chain rather than querying it", async () => {
    const outcome = await addUserContract(CHAIN, "osmo1notthischain");
    expect(outcome.ok).toBe(false);
    expect(await listUserContracts(CHAIN)).toEqual([]);
  });

  it("refuses to run at all on a chain without cosmwasm", async () => {
    await expect(discoverCollections("cosmoshub-4", "cosmos1owner")).rejects.toThrow(
      /cosmwasm/i,
    );
    expect(requested).toEqual([]);
  });

  it("reads nothing while the live-reads gate is off", async () => {
    installBrowser({ liveBalances: false });
    clearInterchainCaches();
    await addUserContract(CHAIN, COLLECTION);
    const result = await discoverCollections(CHAIN, OWNER);
    // The gate throws inside the engine, which records it as an issue rather
    // than a crash - but no request left the device either way.
    expect(requested).toEqual([]);
    expect(result.collections).toEqual([]);
    expect(result.issues.length).toBeGreaterThan(0);
  });
});

describe("loadToken", () => {
  it("contacts no metadata host when artwork is off", async () => {
    const view = await loadToken(CHAIN, COLLECTION, "7");
    expect(view.token.name).toBe("On-chain name");
    expect(view.token.tokenUri).toBe(TOKEN_URI);
    expect(view.metadataSource).toBe("chain");
    // The load-bearing assertion of this file: the token names an IPFS host and
    // not one byte went to it.
    expect(requested.every((url) => url.startsWith(REST))).toBe(true);
  });

  it("reads the token_uri only when asked, through the configured gateway", async () => {
    installFetch({ metadataBody: { description: "From the metadata host" } });
    const view = await loadToken(CHAIN, COLLECTION, "7", {
      withOffChainMetadata: true,
    });
    expect(view.metadataSource).toBe("remote");
    // On-chain values still win; the document only fills what the chain left null.
    expect(view.token.name).toBe("On-chain name");
    expect(view.token.description).toBe("From the metadata host");
    expect(requested.some((url) => url.startsWith("https://ipfs.io/ipfs/"))).toBe(true);
  });

  it("keeps the token when the metadata host fails, and says so", async () => {
    const view = await loadToken(CHAIN, COLLECTION, "7", {
      withOffChainMetadata: true,
    });
    // No `metadataBody` stubbed, so every gateway throws.
    expect(view.token.name).toBe("On-chain name");
    expect(view.metadataError).not.toBeNull();
    expect(view.metadataSource).toBe("chain");
  });
});

describe("verifyNftBridge", () => {
  it("fails closed with a named reason when no address is configured", async () => {
    const check = await verifyNftBridge(CHAIN);
    expect(check.contractAddress).toBeNull();
    expect(check.verifiedAt).toBeNull();
    expect(check.problem).toBe("unset");
    expect(check.reason).toContain("will not guess");
    expect(requested).toEqual([]);
  });
});
