import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChainBalance, TokenBalance } from "../balances";

/**
 * The balance reader against a fake LCD behind `fetch`.
 *
 * Everything between the bank endpoint and the row is real: the catalog, the
 * token table, `identifyHeld` with the engine's denom resolver and channel
 * walk, and the metadata reads. Only the chains are fake. Each case loads a
 * fresh copy of the modules, because the identity facts and the lookups
 * already made live in module state, as they do in one worker.
 */

const REST: Record<string, string> = {
  "osmosis-1": "https://lcd-osmosis.keplr.app",
  "injective-1": "https://lcd-injective.keplr.app",
};
const OSMO_ADDRESS = "osmo1holder000000000000000000000000000000000";
const INJ_ADDRESS = "inj1holder0000000000000000000000000000000000";

/** `ibc/` + sha256 of the full trace, as ibc-go names a voucher. */
function voucher(path: string, baseDenom: string): string {
  return `ibc/${createHash("sha256").update(`${path}/${baseDenom}`).digest("hex").toUpperCase()}`;
}

const USDC_N_ON_OSMOSIS = "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4";
const USDC_N_ON_INJECTIVE = "ibc/2CBC2EA121AE42563B08028466F37B600F2D7D4282342DE938283CC3FB2BC00E";
const USDC_AXL_ON_OSMOSIS = "ibc/D189335C6E4A68B513C10AB227BF1C1D38C746766278BA3EEB4FB14124F1D858";
const PICASSO_ETH_ON_OSMOSIS = "ibc/A23E590BA7E0D808706FB5085A449B3B9D6864AE4DDE7DAF936243CEBB2A3D43";
/** Neutron's ATOM1KLFG, a token-factory denom, as Osmosis holds it. */
const ATOM1KLFG_ON_OSMOSIS = "ibc/0E77E090EC04C476DE2BC0A7056580AC47660DAEB7B0D4701C085E3A046AC7B7";
const USDC_INJ = "erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a";
const USDT_PEGGY = "peggy0xdAC17F958D2ee523a2206206994597C13D831ec7";
const ALL_SHIB = "factory/osmo1f588gk9dazpsueevdl2w6wfkmfmhg5gdvg2uerdlzl0atkasqhsq59qc6a/alloyed/allSHIB";
/** Anyone can mint this on Osmosis and airdrop it. */
const FAKE_USDC_N = "factory/osmo1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqsxyz/USDC.n";
/** A Neutron token-factory denom no registry lists, and its voucher on Osmosis. */
const GLOOP = "factory/neutron1qyqszqgpqyqszqgpqyqszqgpqyqszqgpz3jc3a/GLOOP";
const GLOOP_ON_OSMOSIS = voucher("transfer/channel-874", GLOOP);

interface FakeChain {
  balances: Array<{ denom: string; amount: string }>;
  /** Denom traces the chain answers, by voucher. Anything else is a 404. */
  traces: Record<string, { path: string; base_denom: string }>;
  /** Bank metadata records, by denom. */
  metadata: Record<string, unknown>;
  /** Transfer channels and the chain each one's light client tracks. */
  channels: Record<string, string>;
}

interface FakeWorld {
  chains: Record<string, FakeChain>;
  requested: URL[];
  /** Holds every denom-trace answer until it resolves. */
  gate: Promise<void> | null;
  /** Answers a request before the fake chain does, when it returns a response. */
  hook?: (url: URL, init: RequestInit | undefined) => Promise<Response> | undefined;
}

function chain(patch: Partial<FakeChain>): FakeChain {
  return { balances: [], traces: {}, metadata: {}, channels: {}, ...patch };
}

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const notFound = (what: string) => respond(404, { code: 5, message: `${what}: not found`, details: [] });
const notImplemented = () => respond(501, { code: 12, message: "Not Implemented", details: [] });

async function answer(world: FakeWorld, chainId: string, url: URL): Promise<Response> {
  const fake = world.chains[chainId];
  if (!fake) return notImplemented();
  const path = decodeURIComponent(url.pathname);
  let match: RegExpMatchArray | null;
  if (/^\/cosmos\/bank\/v1beta1\/balances\/[^/]+$/.test(path)) {
    return respond(200, { balances: fake.balances, pagination: { next_key: null, total: String(fake.balances.length) } });
  }
  if (path.startsWith("/cosmos/staking/v1beta1/delegations/")) return respond(200, { delegation_responses: [] });
  if (path.startsWith("/cosmos/distribution/v1beta1/delegators/")) return respond(200, { rewards: [], total: [] });
  if ((match = path.match(/^\/ibc\/apps\/transfer\/v1\/denom_traces\/([0-9A-F]{64})$/))) {
    if (world.gate) await world.gate;
    const trace = fake.traces[`ibc/${match[1]}`];
    return trace ? respond(200, { denom_trace: trace }) : notFound(path);
  }
  if (path.startsWith("/ibc/apps/transfer/v1/denoms/")) return notFound(path);
  if (path === "/cosmos/bank/v1beta1/denoms_metadata_by_query_string") {
    const record = fake.metadata[url.searchParams.get("denom") ?? ""];
    return record ? respond(200, { metadata: record }) : notFound(path);
  }
  if ((match = path.match(/^\/cosmos\/bank\/v1beta1\/denoms_metadata\/(.+)$/))) {
    // Like the Osmosis and Injective LCDs: the path route cannot carry a `/`.
    if (match[1]!.includes("/")) return notImplemented();
    const record = fake.metadata[match[1]!];
    return record ? respond(200, { metadata: record }) : notFound(path);
  }
  if ((match = path.match(/^\/ibc\/core\/channel\/v1\/channels\/(channel-\d+)\/ports\/transfer$/))) {
    if (!fake.channels[match[1]!]) return notFound(path);
    return respond(200, {
      channel: {
        state: "STATE_OPEN",
        ordering: "ORDER_UNORDERED",
        counterparty: { port_id: "transfer", channel_id: "channel-10" },
        connection_hops: [`connection-of-${match[1]}`],
        version: "ics20-1",
      },
    });
  }
  if ((match = path.match(/^\/ibc\/core\/connection\/v1\/connections\/connection-of-(channel-\d+)$/))) {
    return respond(200, { connection: { client_id: `07-tendermint-of-${match[1]}`, state: "STATE_OPEN" } });
  }
  if ((match = path.match(/^\/ibc\/core\/client\/v1\/client_states\/07-tendermint-of-(channel-\d+)$/))) {
    const tracked = fake.channels[match[1]!];
    if (!tracked) return notFound(path);
    return respond(200, {
      client_state: { "@type": "/ibc.lightclients.tendermint.v1.ClientState", chain_id: tracked },
    });
  }
  return notImplemented();
}

let store: Map<string, unknown>;

/**
 * Stub `fetch` and `browser`, then load fresh modules. `keepStore` keeps the
 * stored records, as a worker that restarts in the same browser session does.
 * `get` replaces the storage read.
 */
async function load(
  world: FakeWorld,
  options: { keepStore?: boolean; get?: (key: string) => Promise<Record<string, unknown>> } = {},
) {
  vi.resetModules();
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    world.requested.push(url);
    const chainId = Object.entries(REST).find(([, rest]) => rest === url.origin)?.[0];
    if (!chainId) throw new Error(`unexpected request to ${url.href}`);
    return world.hook?.(url, init) ?? answer(world, chainId, url);
  });
  if (!options.keepStore) store = new Map<string, unknown>([["zunia.settings", { liveBalances: true }]]);
  vi.stubGlobal("browser", {
    storage: {
      local: {
        get: options.get ?? (async (key: string) => ({ [key]: store.get(key) })),
        set: async (patch: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(patch)) store.set(key, value);
        },
        remove: async (key: string) => void store.delete(key),
      },
      onChanged: { addListener: () => undefined },
    },
    permissions: { contains: async () => true },
  });
  return import("../balances");
}

function world(chains: Record<string, FakeChain>): FakeWorld {
  return { chains, requested: [], gate: null };
}

/** Requests whose path matches, so a case can count reads. */
function requests(target: FakeWorld, pattern: RegExp): URL[] {
  return target.requested.filter((url) => pattern.test(decodeURIComponent(url.pathname)));
}

/** Distinct vouchers whose trace was asked for. */
function tracedVouchers(target: FakeWorld): Set<string> {
  return new Set(
    requests(target, /^\/ibc\/apps\/transfer\/v1\/denom_traces\//).map(
      (url) => `ibc/${url.pathname.split("/").pop()}`,
    ),
  );
}

function tokenOf(balance: ChainBalance | undefined, denom: string): TokenBalance {
  const token = balance?.tokens.find((row) => row.denom === denom);
  if (!token) throw new Error(`${denom} is not among the rows`);
  return token;
}

const osmosis = (balances: ChainBalance[]) => balances.find((row) => row.chainId === "osmosis-1");
const injective = (balances: ChainBalance[]) => balances.find((row) => row.chainId === "injective-1");

/** Answer after `ms`, unless the request is aborted first (its 8 s timeout). */
function delayed(ms: number, init: RequestInit | undefined, then: () => Promise<Response>): Promise<Response> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => void then().then(resolve, reject), ms);
    init?.signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    });
  });
}

/** What ibc-go writes for every voucher it mints (Osmosis, live). */
function generatedMetadata(denom: string, path: string, base: string): Record<string, unknown> {
  return {
    description: `IBC token from ${path}/${base}`,
    denom_units: [{ denom: base, exponent: 0, aliases: [] }],
    base: denom,
    display: `${path}/${base}`,
    name: `${path}/${base} IBC token`,
    symbol: base.toUpperCase(),
    uri: "",
    uri_hash: "",
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("tokens the table and the catalog name", () => {
  function heldEverywhere(): FakeWorld {
    return world({
      "osmosis-1": chain({
        balances: [
          { denom: "uosmo", amount: "5000000" },
          { denom: USDC_N_ON_OSMOSIS, amount: "11000000" },
          { denom: USDC_AXL_ON_OSMOSIS, amount: "12000000" },
          { denom: PICASSO_ETH_ON_OSMOSIS, amount: "1000000000000000000" },
          { denom: ATOM1KLFG_ON_OSMOSIS, amount: "1000000" },
        ],
      }),
      "injective-1": chain({
        balances: [
          { denom: "inj", amount: "1000000000000000000" },
          { denom: USDC_INJ, amount: "21000000" },
          { denom: USDC_N_ON_INJECTIVE, amount: "22000000" },
          { denom: USDT_PEGGY, amount: "23000000" },
        ],
        metadata: {
          // Live shape, with the exponent changed: none of it may be read.
          [USDC_INJ]: {
            description: "",
            denom_units: [
              { denom: USDC_INJ, exponent: 0, aliases: [] },
              { denom: "USDC", exponent: 18, aliases: ["USDC"] },
            ],
            base: USDC_INJ,
            display: "USDC",
            name: "USDC",
            symbol: "USDC",
            decimals: 18,
          },
          [USDT_PEGGY]: { display: "USDT", name: "Tether", symbol: "USDT", denom_units: [] },
        },
      }),
    });
  }

  async function readBoth(target: FakeWorld) {
    const balances = await load(target);
    return balances.getChainBalances([
      { chainId: "osmosis-1", address: OSMO_ADDRESS },
      { chainId: "injective-1", address: INJ_ADDRESS },
    ]);
  }

  it("reads Noble USDC as USDC.n on Osmosis and on Injective, with the USDC logo", async () => {
    const rows = await readBoth(heldEverywhere());
    const onOsmosis = tokenOf(osmosis(rows), USDC_N_ON_OSMOSIS);
    const onInjective = tokenOf(injective(rows), USDC_N_ON_INJECTIVE);
    for (const [token, path] of [
      [onOsmosis, "transfer/channel-750"],
      [onInjective, "transfer/channel-148"],
    ] as const) {
      expect(token).toMatchObject({
        kind: "ibc",
        symbol: "USDC.n",
        displayName: "USDC.n",
        originChainId: "noble-1",
        originChainName: "Noble",
        baseDenom: "uusdc",
        ibcPath: path,
        decimals: 6,
        decimalsKnown: true,
        proven: true,
        name: "Noble USDC",
      });
    }
    expect(onOsmosis.iconUrl).toMatch(/usdc\.png$/);
    expect(onInjective.iconUrl).toBe(onOsmosis.iconUrl);
  });

  it("tells Axelar USDC apart and names Picasso ETH and an IBC factory token", async () => {
    const rows = await readBoth(heldEverywhere());
    expect(tokenOf(osmosis(rows), USDC_AXL_ON_OSMOSIS)).toMatchObject({
      symbol: "USDC.axl",
      originChainId: "axelar-dojo-1",
      decimals: 6,
      proven: true,
    });
    expect(tokenOf(osmosis(rows), PICASSO_ETH_ON_OSMOSIS)).toMatchObject({
      symbol: "ETH.pica",
      decimals: 18,
      decimalsKnown: true,
    });
    expect(tokenOf(osmosis(rows), ATOM1KLFG_ON_OSMOSIS)).toMatchObject({
      kind: "ibc",
      symbol: "ATOM1KLFG",
      originChainId: "neutron-1",
    });
  });

  it("keeps Injective's USDC as USDC.inj although its metadata says USDC", async () => {
    const target = heldEverywhere();
    const rows = await readBoth(target);
    expect(tokenOf(injective(rows), USDC_INJ)).toMatchObject({
      kind: "other",
      symbol: "USDC.inj",
      displayName: "USDC.inj",
      decimals: 6,
      decimalsKnown: true,
      originChainId: "injective-1",
      baseDenom: USDC_INJ,
      proven: true,
    });
    expect(tokenOf(injective(rows), USDT_PEGGY).symbol).toBe("USDT.peggy");
    // A named token costs no metadata read and no trace lookup.
    expect(requests(target, /denoms_metadata/)).toHaveLength(0);
    expect(tracedVouchers(target).size).toBe(0);
  });

  it("shows each chain's own coin as the chain-level row does", async () => {
    const rows = await readBoth(heldEverywhere());
    expect(osmosis(rows)).toMatchObject({ symbol: "OSMO", available: "5000000", decimals: 6 });
    expect(tokenOf(osmosis(rows), "uosmo")).toMatchObject({
      kind: "native",
      symbol: "OSMO",
      decimals: 6,
      decimalsKnown: true,
      proven: true,
      originChainId: "osmosis-1",
    });
    expect(tokenOf(injective(rows), "inj")).toMatchObject({ kind: "native", symbol: "INJ", decimals: 18 });
  });

  it("never labels a row /IBC and never gives a voucher the holding chain's logo", async () => {
    const balances = await load(heldEverywhere());
    const rows = await balances.getChainBalances([
      { chainId: "osmosis-1", address: OSMO_ADDRESS },
      { chainId: "injective-1", address: INJ_ADDRESS },
    ]);
    const { catalogIconFor, findCatalogEntry } = await import("../chain-catalog");
    for (const balance of rows) {
      const chainIcon = catalogIconFor(findCatalogEntry(balance.chainId)!);
      for (const token of balance.tokens) {
        expect(token.displayName).not.toMatch(/\/IBC|FACTORY/i);
        expect(token.symbol).toBe(token.displayName);
        if (token.kind !== "native") expect(token.iconUrl).not.toBe(chainIcon);
      }
    }
  });
});

describe("vouchers the table does not list", () => {
  function gloopWorld(): FakeWorld {
    return world({
      "osmosis-1": chain({
        balances: [{ denom: GLOOP_ON_OSMOSIS, amount: "7000000" }],
        traces: { [GLOOP_ON_OSMOSIS]: { path: "transfer/channel-874", base_denom: GLOOP } },
        metadata: { [GLOOP_ON_OSMOSIS]: generatedMetadata(GLOOP_ON_OSMOSIS, "transfer/channel-874", GLOOP) },
        channels: { "channel-874": "neutron-1" },
      }),
    });
  }

  it("walks an IBC factory token once and shows its subdenom, never FACTORY/", async () => {
    const target = gloopWorld();
    const balances = await load(target);
    const account = { chainId: "osmosis-1", address: OSMO_ADDRESS };
    const [first] = await balances.getChainBalances([account]);
    expect(tokenOf(first, GLOOP_ON_OSMOSIS)).toMatchObject({
      kind: "ibc",
      symbol: "GLOOP",
      displayName: "GLOOP",
      originChainId: "neutron-1",
      originChainName: "Neutron",
      baseDenom: GLOOP,
      ibcPath: "transfer/channel-874",
      // Walked, but no registry names it: no seal and no decimals.
      proven: false,
      decimals: 0,
      decimalsKnown: false,
      name: "Unlisted Neutron token",
    });
    expect(tokenOf(first, GLOOP_ON_OSMOSIS).iconUrl).toBeUndefined();
    // Its origin is known, so the chain's metadata is not asked.
    expect(requests(target, /denoms_metadata/)).toHaveLength(0);

    await balances.getChainBalances([account], { force: true });
    expect(requests(target, /denom_traces/)).toHaveLength(1);

    // A worker that restarts loads the proven trace instead of asking again.
    const restarted = await load(target, { keepStore: true });
    const [again] = await restarted.getChainBalances([account], { force: true });
    expect(tokenOf(again, GLOOP_ON_OSMOSIS).symbol).toBe("GLOOP");
    expect(requests(target, /denom_traces/)).toHaveLength(1);
  });

  it("leaves a voucher whose trace fails unknown, in base units, and asks about it once", async () => {
    const missing = voucher("transfer/channel-999", "uusdc");
    const target = world({
      "osmosis-1": chain({
        balances: [{ denom: missing, amount: "12340000" }],
        metadata: { [missing]: generatedMetadata(missing, "transfer/channel-999", "uusdc") },
      }),
    });
    const balances = await load(target);
    const account = { chainId: "osmosis-1", address: OSMO_ADDRESS };
    const [first] = await balances.getChainBalances([account]);
    const token = tokenOf(first, missing);
    expect(token).toMatchObject({
      kind: "ibc",
      symbol: `IBC·${missing.slice(4, 8)}`,
      displayName: `IBC·${missing.slice(4, 8)}`,
      amount: "12340000",
      decimals: 0,
      decimalsKnown: false,
      proven: false,
      name: "Unknown token",
    });
    expect(token.originChainId).toBeUndefined();
    expect(token.baseDenom).toBeUndefined();
    expect(token.iconUrl).toBeUndefined();
    // The generated record (UUSDC, exponent 0) was read and ignored.
    const metadataReads = requests(target, /^\/cosmos\/bank\/v1beta1\/denoms_metadata_by_query_string$/);
    expect(metadataReads.map((url) => url.searchParams.get("denom"))).toEqual([missing]);

    const traced = requests(target, /^\/ibc\/apps\/transfer\/v1\/(denom_traces|denoms)\//).length;
    expect(tracedVouchers(target)).toEqual(new Set([missing]));
    await balances.getChainBalances([account], { force: true });
    await balances.getChainBalances([account], { force: true });
    expect(requests(target, /^\/ibc\/apps\/transfer\/v1\/(denom_traces|denoms)\//)).toHaveLength(traced);
    expect(requests(target, /denoms_metadata/)).toHaveLength(1);
  });

  it("rejects a trace that does not hash to the voucher", async () => {
    const forged = voucher("transfer/channel-998", "uusdc");
    const target = world({
      "osmosis-1": chain({
        balances: [{ denom: forged, amount: "1000000" }],
        // ATOM's real trace, answered for a hash it does not produce.
        traces: { [forged]: { path: "transfer/channel-0", base_denom: "uatom" } },
        channels: { "channel-0": "cosmoshub-4" },
      }),
    });
    const balances = await load(target);
    const [row] = await balances.getChainBalances([{ chainId: "osmosis-1", address: OSMO_ADDRESS }]);
    expect(tokenOf(row, forged)).toMatchObject({
      symbol: `IBC·${forged.slice(4, 8)}`,
      decimalsKnown: false,
      proven: false,
    });
    expect(tokenOf(row, forged).originChainId).toBeUndefined();
    expect(JSON.stringify(store.get("zunia.tokenIdentity") ?? {})).not.toContain(forged);
  });

  it("asks about at most 32 vouchers per chain read and the rest on the next one", async () => {
    const vouchers = Array.from({ length: 40 }, (_, index) => voucher(`transfer/channel-${5000 + index}`, "uusdc"));
    const target = world({
      "osmosis-1": chain({ balances: vouchers.map((denom) => ({ denom, amount: "1" })) }),
    });
    const balances = await load(target);
    const account = { chainId: "osmosis-1", address: OSMO_ADDRESS };
    await balances.getChainBalances([account]);
    expect(tracedVouchers(target).size).toBe(32);
    await balances.getChainBalances([account], { force: true });
    expect(tracedVouchers(target).size).toBe(40);
    const [last] = await balances.getChainBalances([account], { force: true });
    expect(requests(target, /^\/ibc\/apps\/transfer\/v1\/denom_traces\//)).toHaveLength(40);
    expect(last?.tokens.every((token) => token.decimalsKnown === false)).toBe(true);
  });

  it("lets a read that starts mid-lookup wait for it instead of asking again", async () => {
    const target = gloopWorld();
    let release = () => {};
    target.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const balances = await load(target);
    const account = { chainId: "osmosis-1", address: OSMO_ADDRESS };
    const reads = Promise.all([
      balances.getChainBalances([account], { force: true }),
      balances.getChainBalances([account], { force: true }),
    ]);
    await vi.waitFor(() => expect(requests(target, /\/balances\//)).toHaveLength(2));
    await vi.waitFor(() => expect(requests(target, /denom_traces/)).toHaveLength(1));
    release();
    const [[first], [second]] = await reads;
    expect(tokenOf(first, GLOOP_ON_OSMOSIS).symbol).toBe("GLOOP");
    expect(tokenOf(second, GLOOP_ON_OSMOSIS).symbol).toBe("GLOOP");
    expect(requests(target, /denom_traces/)).toHaveLength(1);
  });

  it("does not hold balances for a slow lookup, and names the token once it lands", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const target = gloopWorld();
    let release = () => {};
    target.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const balances = await load(target);
    const account = { chainId: "osmosis-1", address: OSMO_ADDRESS };
    const slow = balances.getChainBalances([account], { force: true });
    await vi.waitFor(() => expect(requests(target, /denom_traces/)).toHaveLength(1));
    // The reader waits 8 s; the LCD client's own timeout is 9 s.
    await vi.advanceTimersByTimeAsync(8_000);
    const [first] = await slow;
    expect(tokenOf(first, GLOOP_ON_OSMOSIS)).toMatchObject({ symbol: `IBC·${GLOOP_ON_OSMOSIS.slice(4, 8)}` });

    release();
    await vi.waitFor(() => expect(JSON.stringify(store.get("zunia.tokenIdentity") ?? {})).toContain(GLOOP));
    const [later] = await balances.getChainBalances([account], { force: true });
    expect(tokenOf(later, GLOOP_ON_OSMOSIS).symbol).toBe("GLOOP");
    expect(requests(target, /denom_traces/)).toHaveLength(1);
  });
});

describe("bank metadata", () => {
  const amended = voucher("transfer/channel-777", "umystery");
  const deliberate = voucher("transfer/channel-778", "ublob");

  function metadataWorld(): FakeWorld {
    return world({
      "injective-1": chain({
        balances: [
          { denom: amended, amount: "5000000" },
          { denom: deliberate, amount: "250000000" },
        ],
        metadata: {
          // Injective keeps ibc-go's generated text and adds the exponent.
          [amended]: {
            description: "IBC token from transfer/channel-777/umystery",
            denom_units: [
              { denom: amended, exponent: 0, aliases: ["umystery"] },
              { denom: "transfer/channel-777/umystery", exponent: 6, aliases: [] },
            ],
            base: amended,
            display: "transfer/channel-777/umystery",
            name: "transfer/channel-777/umystery IBC token",
            symbol: "MYSTERY",
            decimals: 6,
          },
          [deliberate]: {
            description: "Blob",
            denom_units: [
              { denom: deliberate, exponent: 0, aliases: [] },
              { denom: "blob", exponent: 8, aliases: [] },
            ],
            base: deliberate,
            display: "blob",
            name: "Blob‮ Coin",
            symbol: "USDC.n",
          },
        },
      }),
      "osmosis-1": chain({
        balances: [
          { denom: ALL_SHIB, amount: "1000000000000000000" },
          { denom: FAKE_USDC_N, amount: "1000000" },
        ],
        metadata: {
          [ALL_SHIB]: {
            denom_units: [
              { denom: ALL_SHIB, exponent: 0 },
              { denom: "allSHIB", exponent: 18 },
            ],
            display: "allSHIB",
            name: "allSHIB",
            symbol: "allSHIB",
          },
          [FAKE_USDC_N]: {
            denom_units: [
              { denom: FAKE_USDC_N, exponent: 0 },
              { denom: "USDC.n", exponent: 6 },
            ],
            display: "USDC.n",
            name: "Noble USDC",
            symbol: "USDC.n",
          },
        },
      }),
    });
  }

  async function readAll(target: FakeWorld) {
    const balances = await load(target);
    return balances.getChainBalances([
      { chainId: "injective-1", address: INJ_ADDRESS },
      { chainId: "osmosis-1", address: OSMO_ADDRESS },
    ]);
  }

  it("fills the decimals and the name of an unknown token, never its ticker", async () => {
    const target = metadataWorld();
    const rows = await readAll(target);
    expect(tokenOf(injective(rows), amended)).toMatchObject({
      symbol: `IBC·${amended.slice(4, 8)}`,
      decimals: 6,
      decimalsKnown: true,
      proven: false,
      // The generated name says nothing.
      name: "Unknown token",
    });
    expect(tokenOf(injective(rows), deliberate)).toMatchObject({
      symbol: `IBC·${deliberate.slice(4, 8)}`,
      decimals: 8,
      decimalsKnown: true,
      proven: false,
      name: "Blob Coin",
    });
    // Denoms with `/` go through the query-string route.
    const asked = requests(target, /^\/cosmos\/bank\/v1beta1\/denoms_metadata_by_query_string$/).map((url) =>
      url.searchParams.get("denom"),
    );
    expect(asked.sort()).toEqual([amended, deliberate].sort());
  });

  it("cuts a long name between characters, never inside an emoji", async () => {
    const target = metadataWorld();
    const record = target.chains["injective-1"]!.metadata[deliberate] as Record<string, unknown>;
    record.name = `${"x".repeat(62)}😀😀 and more`;
    const rows = await readAll(target);
    const name = tokenOf(injective(rows), deliberate).name ?? "";
    expect(name).toBe(`${"x".repeat(62)}😀…`);
    expect(name).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it("never overrides a named token's unknown decimals or an unlisted token's tagged ticker", async () => {
    const target = metadataWorld();
    const rows = await readAll(target);
    expect(tokenOf(osmosis(rows), ALL_SHIB)).toMatchObject({
      symbol: "allSHIB",
      decimals: 0,
      decimalsKnown: false,
    });
    const fake = tokenOf(osmosis(rows), FAKE_USDC_N);
    expect(fake.symbol).toMatch(/^USDC\.n·[0-9A-F]{4}$/);
    expect(fake).toMatchObject({
      decimalsKnown: false,
      proven: false,
      name: "Unlisted Osmosis token",
    });
    const asked = requests(target, /denoms_metadata/).map((url) => url.searchParams.get("denom") ?? url.pathname);
    expect(asked.some((denom) => denom.includes("allSHIB") || denom.includes("USDC.n"))).toBe(false);
  });
});

describe("a slow or failing node", () => {
  const amended = voucher("transfer/channel-777", "umystery");
  const account = { chainId: "injective-1", address: INJ_ADDRESS };

  /** Injective's amended ibc-go record: 6 decimals, no name. */
  function amendedRecord(): Record<string, unknown> {
    return {
      description: "IBC token from transfer/channel-777/umystery",
      denom_units: [
        { denom: amended, exponent: 0, aliases: ["umystery"] },
        { denom: "transfer/channel-777/umystery", exponent: 6, aliases: [] },
      ],
      base: amended,
      display: "transfer/channel-777/umystery",
      name: "transfer/channel-777/umystery IBC token",
      symbol: "MYSTERY",
      decimals: 6,
    };
  }

  function amendedWorld(): FakeWorld {
    return world({
      "injective-1": chain({
        balances: [{ denom: amended, amount: "5000000" }],
        metadata: { [amended]: amendedRecord() },
      }),
    });
  }

  const metadataReads = (target: FakeWorld) => requests(target, /denoms_metadata/).length;

  it("waits at most 3 s for metadata, and the next read has the answer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const target = amendedWorld();
    // Answers in 7 s: slow, but inside the request's own 8 s timeout.
    target.hook = (url, init) =>
      url.pathname.includes("denoms_metadata") ? delayed(7_000, init, () => answer(target, "injective-1", url)) : undefined;
    const balances = await load(target);
    let done = false;
    const read = balances.getChainBalances([account]).finally(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(2_900);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(done).toBe(true);
    const [first] = await read;
    expect(tokenOf(first, amended)).toMatchObject({ decimals: 0, decimalsKnown: false });

    // The answer lands after the read stopped waiting, and that read is not
    // served from the cache: the next one asks the chain again and has it.
    await vi.advanceTimersByTimeAsync(4_000);
    const [next] = await balances.getChainBalances([account]);
    expect(tokenOf(next, amended)).toMatchObject({ decimals: 6, decimalsKnown: true });
    expect(requests(target, /\/balances\//)).toHaveLength(2);
    expect(metadataReads(target)).toBe(1);
  });

  it("asks once when two reads want the same metadata", async () => {
    const target = amendedWorld();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    target.hook = (url) =>
      url.pathname.includes("denoms_metadata") ? gate.then(() => answer(target, "injective-1", url)) : undefined;
    const balances = await load(target);
    const reads = Promise.all([
      balances.getChainBalances([account], { force: true }),
      balances.getChainBalances([account], { force: true }),
    ]);
    await vi.waitFor(() => expect(requests(target, /\/balances\//)).toHaveLength(2));
    await vi.waitFor(() => expect(metadataReads(target)).toBe(1));
    // Long enough for the second read to reach the metadata step and ask.
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    const [[first], [second]] = await reads;
    expect(tokenOf(first, amended).decimals).toBe(6);
    expect(tokenOf(second, amended).decimals).toBe(6);
    expect(metadataReads(target)).toBe(1);
  });

  it("keeps known decimals through a failed refresh, and retries a failed read after a minute", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-05T12:00:00Z"));
    const target = amendedWorld();
    const balances = await load(target);
    const [first] = await balances.getChainBalances([account]);
    expect(tokenOf(first, amended)).toMatchObject({ decimals: 6, decimalsKnown: true });
    expect(metadataReads(target)).toBe(1);

    // Past the half hour the node fails. The refresh is asked, and a blip does
    // not turn 5 tokens into 5000000 base units.
    target.hook = (url) =>
      url.pathname.includes("denoms_metadata") ? Promise.resolve(respond(503, { code: 14, message: "unavailable" })) : undefined;
    vi.setSystemTime(new Date("2026-10-05T12:31:00Z"));
    const [failed] = await balances.getChainBalances([account], { force: true });
    expect(metadataReads(target)).toBe(2);
    expect(tokenOf(failed, amended)).toMatchObject({ decimals: 6, decimalsKnown: true });

    // The failed read is not asked again for a minute, then it is.
    await balances.getChainBalances([account], { force: true });
    expect(metadataReads(target)).toBe(2);
    vi.setSystemTime(new Date("2026-10-05T12:32:01Z"));
    await balances.getChainBalances([account], { force: true });
    expect(metadataReads(target)).toBe(3);
  });

  it("ignores a record that belongs to another denom", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-05T12:00:00Z"));
    const target = amendedWorld();
    // A cache keyed on the path alone hands every query the same record.
    target.hook = (url) =>
      url.pathname.endsWith("denoms_metadata_by_query_string")
        ? Promise.resolve(
            respond(200, {
              metadata: {
                denom_units: [
                  { denom: USDC_INJ, exponent: 0, aliases: [] },
                  { denom: "USDC", exponent: 18, aliases: [] },
                ],
                base: USDC_INJ,
                display: "USDC",
                name: "USDC",
                symbol: "USDC",
              },
            }),
          )
        : undefined;
    const balances = await load(target);
    const [first] = await balances.getChainBalances([account]);
    expect(tokenOf(first, amended)).toMatchObject({ decimals: 0, decimalsKnown: false, name: "Unknown token" });

    // Not remembered as "no metadata": once the node answers properly, a
    // later read has the decimals.
    target.hook = undefined;
    vi.setSystemTime(new Date("2026-10-05T12:01:01Z"));
    const [later] = await balances.getChainBalances([account], { force: true });
    expect(tokenOf(later, amended)).toMatchObject({ decimals: 6, decimalsKnown: true });
  });

  it("does not wait on storage that never answers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const target = world({
      "osmosis-1": chain({ balances: [{ denom: USDC_N_ON_OSMOSIS, amount: "11000000" }] }),
    });
    const balances = await load(target, {
      get: (key) =>
        key === "zunia.tokenIdentity" ? new Promise(() => {}) : Promise.resolve({ [key]: store.get(key) }),
    });
    let done = false;
    const read = balances.getChainBalances([{ chainId: "osmosis-1", address: OSMO_ADDRESS }]).finally(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(done).toBe(true);
    const [row] = await read;
    expect(tokenOf(row, USDC_N_ON_OSMOSIS)).toMatchObject({ symbol: "USDC.n", decimals: 6 });
  });

  it("does not serve a read that stopped waiting for names from the cache", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const target = world({
      "osmosis-1": chain({
        balances: [{ denom: GLOOP_ON_OSMOSIS, amount: "7000000" }],
        traces: { [GLOOP_ON_OSMOSIS]: { path: "transfer/channel-874", base_denom: GLOOP } },
        channels: { "channel-874": "neutron-1" },
      }),
    });
    let release = () => {};
    target.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const balances = await load(target);
    const osmosisAccount = { chainId: "osmosis-1", address: OSMO_ADDRESS };
    const slow = balances.getChainBalances([osmosisAccount]);
    await vi.waitFor(() => expect(requests(target, /denom_traces/)).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(8_000);
    const [first] = await slow;
    expect(tokenOf(first, GLOOP_ON_OSMOSIS).symbol).toBe(`IBC·${GLOOP_ON_OSMOSIS.slice(4, 8)}`);

    release();
    await vi.waitFor(() => expect(JSON.stringify(store.get("zunia.tokenIdentity") ?? {})).toContain(GLOOP));
    // Not forced, and within the minute: the provisional row is read again.
    const [named] = await balances.getChainBalances([osmosisAccount]);
    expect(tokenOf(named, GLOOP_ON_OSMOSIS).symbol).toBe("GLOOP");
    expect(requests(target, /\/balances\//)).toHaveLength(2);
    // A read that had every answer is cached as before.
    await balances.getChainBalances([osmosisAccount]);
    expect(requests(target, /\/balances\//)).toHaveLength(2);
    expect(requests(target, /denom_traces/)).toHaveLength(1);
  });
});

describe("the balance cache", () => {
  const key = `osmosis-1:${OSMO_ADDRESS}`;

  function usdcWorld(): FakeWorld {
    return world({
      "osmosis-1": chain({ balances: [{ denom: USDC_N_ON_OSMOSIS, amount: "11000000" }] }),
    });
  }

  it("drops a version-5 record instead of serving its old labels", async () => {
    const target = usdcWorld();
    const balances = await load(target);
    store.set("zunia.balanceCache", {
      version: 5,
      balances: {
        [key]: {
          at: Date.now(),
          balance: {
            chainId: "osmosis-1",
            available: "0",
            staked: "0",
            rewards: "0",
            denom: "uosmo",
            decimals: 6,
            symbol: "OSMO",
            // Shaped like a version-6 row, so only the version can drop it.
            tokens: [
              {
                denom: USDC_N_ON_OSMOSIS,
                amount: "11000000",
                kind: "ibc",
                symbol: "USDC.axl",
                displayName: "USDC.axl/IBC",
                decimals: 6,
                decimalsKnown: true,
                proven: true,
                originChainName: "Axelar",
              },
            ],
          },
        },
      },
    });
    const [row] = await balances.getChainBalances([{ chainId: "osmosis-1", address: OSMO_ADDRESS }]);
    expect(requests(target, /\/balances\//)).toHaveLength(1);
    expect(tokenOf(row, USDC_N_ON_OSMOSIS)).toMatchObject({ symbol: "USDC.n", displayName: "USDC.n" });
    const stored = store.get("zunia.balanceCache") as { version: number; balances: Record<string, unknown> };
    expect(stored.version).toBe(6);
    expect(JSON.stringify(stored.balances[key])).not.toContain("USDC.axl");
  });

  it("serves a version-6 row from the cache", async () => {
    const target = usdcWorld();
    const balances = await load(target);
    const account = { chainId: "osmosis-1", address: OSMO_ADDRESS };
    await balances.getChainBalances([account]);
    const [cached] = await balances.getChainBalances([account]);
    expect(requests(target, /\/balances\//)).toHaveLength(1);
    expect(tokenOf(cached, USDC_N_ON_OSMOSIS).symbol).toBe("USDC.n");
  });
});

describe("classifyToken", () => {
  const native = { chainId: "osmosis-1", denom: "uosmo", symbol: "OSMO", decimals: 6 };

  it("takes metadata only for an unknown identity", async () => {
    vi.resetModules();
    const { classifyToken } = await import("../balances");
    const { identityOf } = await import("../token-identity");
    const metadata = { name: "Fake Dollar", decimals: 18 };
    const named = classifyToken(USDC_N_ON_OSMOSIS, "1", native, {
      identity: identityOf("osmosis-1", USDC_N_ON_OSMOSIS),
      metadata,
    });
    expect(named).toMatchObject({ symbol: "USDC.n", decimals: 6, name: "Noble USDC" });
    const unlisted = voucher("transfer/channel-4242", "ufake");
    const unknown = classifyToken(unlisted, "1", native, {
      identity: identityOf("osmosis-1", unlisted),
      metadata,
    });
    expect(unknown).toMatchObject({
      symbol: `IBC·${unlisted.slice(4, 8)}`,
      decimals: 18,
      decimalsKnown: true,
      name: "Fake Dollar",
      proven: false,
    });
  });

  it("looks the identity up on the chain it is given", async () => {
    vi.resetModules();
    const { classifyToken } = await import("../balances");
    expect(classifyToken(USDC_AXL_ON_OSMOSIS, "1", native)).toMatchObject({
      symbol: "USDC.axl",
      originChainId: "axelar-dojo-1",
    });
    expect(classifyToken("uosmo", "1", native)).toMatchObject({ kind: "native", symbol: "OSMO", decimalsKnown: true });
  });
});

describe("heldTokenIdentity", () => {
  it("lends an unknown token the row's decimals and leaves a named token's identity alone", async () => {
    vi.resetModules();
    const { heldTokenIdentity } = await import("../balances");
    const unlisted = voucher("transfer/channel-4242", "ufake");
    expect(heldTokenIdentity("injective-1", { denom: unlisted, decimals: 8, decimalsKnown: true })).toMatchObject({
      provenance: "unknown",
      ticker: `IBC·${unlisted.slice(4, 8)}`,
      decimals: 8,
      decimalsKnown: true,
      proven: false,
    });
    expect(heldTokenIdentity("injective-1", { denom: unlisted, decimals: 0, decimalsKnown: false })).toMatchObject({
      decimals: 0,
      decimalsKnown: false,
    });
    // A row built by hand from the catalog has no `decimalsKnown`: known.
    expect(heldTokenIdentity("injective-1", { denom: unlisted, decimals: 6 })).toMatchObject({ decimals: 6, decimalsKnown: true });
    // A named token is its identity, whatever a row says.
    expect(heldTokenIdentity("osmosis-1", { denom: USDC_N_ON_OSMOSIS, decimals: 18, decimalsKnown: true })).toMatchObject({
      ticker: "USDC.n",
      decimals: 6,
    });
    expect(heldTokenIdentity("osmosis-1", { denom: ALL_SHIB, decimals: 18, decimalsKnown: true })).toMatchObject({
      ticker: "allSHIB",
      decimals: 0,
      decimalsKnown: false,
    });
  });

  it("agrees with every row the reader builds", async () => {
    const amended = voucher("transfer/channel-777", "umystery");
    const missing = voucher("transfer/channel-999", "uusdc");
    const target = world({
      "injective-1": chain({
        balances: [
          { denom: "inj", amount: "1000000000000000000" },
          { denom: USDC_INJ, amount: "21000000" },
          { denom: amended, amount: "5000000" },
          { denom: missing, amount: "12340000" },
        ],
        metadata: {
          [amended]: {
            description: "IBC token from transfer/channel-777/umystery",
            denom_units: [
              { denom: amended, exponent: 0, aliases: ["umystery"] },
              { denom: "transfer/channel-777/umystery", exponent: 6, aliases: [] },
            ],
            base: amended,
            display: "transfer/channel-777/umystery",
            name: "transfer/channel-777/umystery IBC token",
            decimals: 6,
          },
        },
      }),
    });
    const balances = await load(target);
    const [row] = await balances.getChainBalances([{ chainId: "injective-1", address: INJ_ADDRESS }]);
    for (const token of row?.tokens ?? []) {
      const identity = balances.heldTokenIdentity("injective-1", token);
      expect([identity.denom, identity.decimals, identity.decimalsKnown]).toEqual([
        token.denom,
        token.decimals,
        token.decimalsKnown,
      ]);
    }
    expect(balances.heldTokenIdentity("injective-1", tokenOf(row, amended))).toMatchObject({ decimals: 6, ticker: `IBC·${amended.slice(4, 8)}` });
    expect(balances.heldTokenIdentity("injective-1", tokenOf(row, missing))).toMatchObject({ decimalsKnown: false });
  });
});
