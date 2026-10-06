/**
 * Which pairs Zunia's Osmosis swap contract can execute, read from the
 * contract's own route table.
 *
 * The crosschain-swaps contract (code 37, "CrossChainSwaps v1.2") takes no
 * route in its memo: it asks its swaprouter `get_route(input, output)` and
 * refuses the packet when the router has no entry. SQS prices far more pairs
 * than that table holds (on 2026-10-05: 39 directional routes over 20 denoms,
 * against 1,319 listed tokens). Those pairs are swapped in Osmosis's own pools
 * instead (lib/pool-swap.ts), so the table's answer picks the path for a pair
 * (lib/swap-path.ts) rather than whether it can be swapped at all.
 *
 * The table is read once per session and cached in `storage.session`: the
 * contract's raw `config` names the router (`swap_contract`), and the router's
 * paginated contract state holds the `routing_table` map. The answer is
 * advisory. The route gate in lib/route-plan.ts (`readXcsExecutableRoute`,
 * live, per pair) still decides what the contract path may sign, and nothing
 * here can enable a pair that gate refuses. When the table cannot be read
 * every answer is `unknown`, and `unknown` never disables a row.
 */

import {
  base64ToJson,
  bytesToUtf8,
  encodeBase64Utf8,
  InterchainError,
  isInterchainError,
  parseXcsSwapContract,
  type LcdClient,
  type LcdRequestOptions,
} from "@zunialab/interchain";
import { hexToBytes } from "@noble/hashes/utils.js";

import { SWAP_VENUE_CHAIN_ID } from "../config/interchain";
import { chainRegistry, lcdFor } from "./interchain";
import { swapPathFor } from "./swap-path";
import { STORAGE_KEYS } from "./storage-keys";
import { identityOf, type TokenIdentity } from "./token-identity";

/** `yes`: the router has the pair. `no`: it has not. `unknown`: no table to ask, or a side it cannot name. */
export type Executable = "yes" | "no" | "unknown";

/** One entry of the swaprouter's `routing_table`. */
export interface XcsRoute {
  /** Denom the contract receives on Osmosis. */
  readonly input: string;
  /** Denom it pays out on Osmosis. */
  readonly output: string;
  /** Pools in the order the router swaps through them. */
  readonly poolIds: readonly string[];
}

/** The route table of one crosschain-swaps deployment. Plain data, so it caches as JSON. */
export interface XcsRouteTable {
  /** The crosschain-swaps contract the memo calls. */
  readonly xcsContract: string;
  /** Its swaprouter, from the contract's raw `config`. */
  readonly swapContract: string;
  readonly routes: readonly XcsRoute[];
  /** `Date.now()` of the read. */
  readonly readAt: number;
}

/** What gating needs from a swap row: where it is, its exact denom and what it is. */
export interface GateSide {
  readonly key: string;
  readonly chainId: string;
  readonly denom: string;
  readonly identity: TokenIdentity;
  /** On a test network. Zunia's only swap venue is Osmosis mainnet. */
  readonly testnet: boolean;
}

/** The verdict on one To row for the current From. */
export interface Gate {
  /** What the route table says about the pair, and nothing else. */
  readonly executable: Executable;
  /** Why the row cannot be picked; `null` when it can. */
  readonly disabledReason: string | null;
}

/** Bumped when {@link CacheRecord} changes shape; a record of another version is ignored. */
export const XCS_ROUTES_CACHE_VERSION = 1;
/** The router's owner can add routes at any time; the live gate covers the gap, so an hour only costs UX. */
export const XCS_ROUTES_TTL_MS = 60 * 60_000;

const VENUE = SWAP_VENUE_CHAIN_ID;
/** The cw-storage-plus namespace of the router's `Map<(&str, &str), Vec<SwapAmountInRoute>>`. */
const ROUTING_TABLE = "routing_table";
const PAGE_LIMIT = 100;
/**
 * A table this long would be 20,000 routes. A router that pages past it is
 * not the contract this was written for, so the read fails (and gates
 * nothing) instead of trusting a partial table.
 */
const MAX_PAGES = 200;
const COSMOS_DENOM = /^[a-zA-Z][a-zA-Z0-9/:._-]{1,127}$/;

/* -------------------------------------------------------------------------- *
 * Reasons, in the words the picker shows
 * -------------------------------------------------------------------------- */

/** A pair the route table does not hold. */
export function noRouteReason(fromTicker: string, toTicker: string): string {
  return `Zunia's Osmosis swap contract has no route from ${fromTicker} to ${toTicker} yet.`;
}

/**
 * A side Osmosis has no denom for: neither the contract nor Osmosis's own
 * pools can trade it.
 */
export function notTradedReason(ticker: string): string {
  return `${ticker} is not traded on Osmosis, so Zunia cannot swap it.`;
}

/** The To row is the From row itself. */
export const SELF_REASON = "This is the token you are selling.";

/** The same asset somewhere else: the planner refuses it as `same-token`. */
export const SAME_TOKEN_REASON = "Same token as the one you sell. Use Send to move it.";

/** Either side on a test network: nothing there reaches Osmosis mainnet. */
export const TESTNET_REASON = "Zunia swaps on Osmosis mainnet, so it cannot swap testnet tokens.";

/* -------------------------------------------------------------------------- *
 * Parsing the router's state
 * -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Bech32-ish, as the engine checks a contract before querying it. */
function looksLikeAddress(value: string): boolean {
  return /^[a-z0-9]+1[a-z0-9]{20,}$/.test(value);
}

/** `ibc/` hashes compare without case; every other denom exactly. */
function denomKey(denom: string): string {
  return denom.startsWith("ibc/") ? `ibc/${denom.slice(4).toUpperCase()}` : denom;
}

function pairKey(input: string, output: string): string {
  // NUL cannot occur in a denom, so two pairs never share a key.
  return `${denomKey(input)}\u0000${denomKey(output)}`;
}

function utf8(bytes: Uint8Array): string | null {
  try {
    return bytesToUtf8(bytes);
  } catch {
    return null;
  }
}

/**
 * The pair a `routing_table` key names. cw-storage-plus writes a composite
 * key as: the namespace's length (u16, big-endian), the namespace, the first
 * element's length (u16), the first element, then the last element with no
 * length. Items such as `contract_info` and `state` are stored under their
 * bare name, so their first two bytes are not a length that fits, and they
 * are skipped like anything else that is not this map.
 */
function routeKeyOf(hex: unknown): { input: string; output: string } | null {
  if (typeof hex !== "string" || hex.length < 4 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    return null;
  }
  const key = hexToBytes(hex);
  const namespaceLength = ((key[0] ?? 0) << 8) | (key[1] ?? 0);
  const namespaceEnd = 2 + namespaceLength;
  if (namespaceEnd + 2 > key.length) return null;
  if (utf8(key.subarray(2, namespaceEnd)) !== ROUTING_TABLE) return null;
  const inputLength = ((key[namespaceEnd] ?? 0) << 8) | (key[namespaceEnd + 1] ?? 0);
  const inputEnd = namespaceEnd + 2 + inputLength;
  if (inputLength === 0 || inputEnd >= key.length) return null;
  const input = utf8(key.subarray(namespaceEnd + 2, inputEnd));
  const output = utf8(key.subarray(inputEnd));
  if (!input || !output || !COSMOS_DENOM.test(input) || !COSMOS_DENOM.test(output)) return null;
  return { input, output };
}

/**
 * The pools of a stored route, or `null` when the value is not a route that
 * ends in `output`. Such an entry is left out: `get_route` would hand the
 * engine the same value, the engine would refuse it, and the pair could not
 * be signed anyway.
 */
function poolIdsOf(value: unknown, output: string): string[] | null {
  if (typeof value !== "string" || !value) return null;
  let hops: unknown;
  try {
    hops = base64ToJson(value);
  } catch {
    return null;
  }
  if (!Array.isArray(hops) || hops.length === 0) return null;
  const pools: string[] = [];
  let last: unknown = null;
  for (const hop of hops) {
    if (!isRecord(hop)) return null;
    const id = typeof hop.pool_id === "number" ? String(hop.pool_id) : hop.pool_id;
    if (typeof id !== "string" || !/^[1-9]\d*$/.test(id)) return null;
    pools.push(id);
    last = hop.token_out_denom;
  }
  return last === output ? pools : null;
}

/**
 * Every route in a swaprouter's raw contract state (`models` from
 * `/cosmwasm/wasm/v1/contract/{router}/state`, all pages together).
 * Models that are not `routing_table` entries, or do not parse, are skipped.
 */
export function parseRouterState(models: readonly unknown[]): XcsRoute[] {
  const out: XcsRoute[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    if (!isRecord(model)) continue;
    const pair = routeKeyOf(model.key);
    if (!pair) continue;
    const poolIds = poolIdsOf(model.value, pair.output);
    const key = pairKey(pair.input, pair.output);
    if (!poolIds || seen.has(key)) continue;
    seen.add(key);
    out.push({ input: pair.input, output: pair.output, poolIds });
  }
  return out;
}

/* -------------------------------------------------------------------------- *
 * Reading the table
 * -------------------------------------------------------------------------- */

function malformed(chainId: string, message: string): InterchainError {
  return new InterchainError("malformed-response", `${chainId}: ${message}`, { chainId });
}

/** A raw or smart query's `data`: base64 JSON on the wire, already parsed on some gateways. */
function queryData(body: unknown, chainId: string): unknown {
  if (!isRecord(body) || !("data" in body)) throw malformed(chainId, "contract query has no data");
  const data = body.data;
  if (typeof data === "string") return base64ToJson(data);
  if (data === null || data === undefined) throw malformed(chainId, "contract query returned empty data");
  return data;
}

/**
 * Read a crosschain-swaps deployment's route table from chain: the
 * contract's raw `config` for its `swap_contract`, then that router's
 * contract state, page by page, then the `routing_table` keys.
 *
 * @throws {@link InterchainError}: `invalid-request` for an address that is
 *   not one, `malformed-response` when the config names no router or the
 *   state holds no route (a table this cannot read is not an empty table),
 *   and the LCD client's own codes (`lcd-unreachable`, `reads-disabled`,
 *   `aborted`).
 */
export async function readRoutingTable(
  lcd: LcdClient,
  xcsContract: string,
  options: { readonly signal?: AbortSignal; readonly now?: number } = {},
): Promise<XcsRouteTable> {
  const contract = xcsContract.trim();
  if (!looksLikeAddress(contract)) {
    throw new InterchainError("invalid-request", `${contract || "(empty)"} is not a contract address`, {
      chainId: lcd.chainId,
    });
  }
  // Read fresh: this module caches the table for the session, and an hour-old
  // page from the client cache would make the read look newer than it is.
  const request: LcdRequestOptions = {
    retries: 1,
    timeoutMs: 10_000,
    cacheTtlMs: 0,
    ...(options.signal ? { signal: options.signal } : {}),
  };

  // The key is the raw bytes of the word `config`, not a JSON string.
  const configPath = `/cosmwasm/wasm/v1/contract/${encodeURIComponent(contract)}/raw/${encodeURIComponent(
    encodeBase64Utf8("config"),
  )}`;
  const swapContract = parseXcsSwapContract(queryData(await lcd.getJson(configPath, request), lcd.chainId));
  if (!swapContract) throw malformed(lcd.chainId, `${contract} has no swap_contract in its config`);

  const statePath = `/cosmwasm/wasm/v1/contract/${encodeURIComponent(swapContract)}/state`;
  const models: unknown[] = [];
  const asked = new Set<string>();
  let next: string | null = null;
  for (let page = 0; ; page += 1) {
    if (page >= MAX_PAGES) throw malformed(lcd.chainId, `${swapContract} state did not end within ${MAX_PAGES} pages`);
    const body = await lcd.getJson(statePath, {
      ...request,
      query: { "pagination.limit": PAGE_LIMIT, ...(next ? { "pagination.key": next } : {}) },
    });
    if (!isRecord(body) || !Array.isArray(body.models)) {
      throw malformed(lcd.chainId, `${swapContract} state has no models`);
    }
    models.push(...body.models);
    const key = isRecord(body.pagination) ? body.pagination.next_key : null;
    if (typeof key !== "string" || key.length === 0) break;
    // A gateway that drops the query string answers every page with the
    // first one and the same next key. Asking again would only repeat it,
    // MAX_PAGES times, so the read fails now (and gates nothing).
    if (asked.has(key)) throw malformed(lcd.chainId, `${swapContract} state repeats the page after ${key}`);
    asked.add(key);
    next = key;
  }

  const routes = parseRouterState(models);
  if (routes.length === 0) throw malformed(lcd.chainId, `${swapContract} state holds no routing_table entry`);
  return { xcsContract: contract, swapContract, routes, readAt: options.now ?? Date.now() };
}

/* -------------------------------------------------------------------------- *
 * The session cache
 * -------------------------------------------------------------------------- */

/** As stored: routes as `[input, output, ...poolIds]` tuples. */
interface CacheRecord {
  readonly version: number;
  readonly xcsContract: string;
  readonly swapContract: string;
  readonly readAt: number;
  readonly routes: readonly (readonly string[])[];
}

/**
 * A stored record for `xcsContract`, when it is this version, fresh, and
 * well formed. Session storage is shared by every extension page, so it is
 * checked like any other input.
 */
function tableFromRecord(raw: unknown, xcsContract: string, now: number): XcsRouteTable | null {
  if (!isRecord(raw) || raw.version !== XCS_ROUTES_CACHE_VERSION) return null;
  const { readAt, swapContract, routes } = raw;
  if (raw.xcsContract !== xcsContract || typeof swapContract !== "string" || !looksLikeAddress(swapContract)) {
    return null;
  }
  if (typeof readAt !== "number" || readAt > now || now - readAt > XCS_ROUTES_TTL_MS) return null;
  if (!Array.isArray(routes) || routes.length === 0) return null;
  const out: XcsRoute[] = [];
  for (const row of routes) {
    if (!Array.isArray(row) || row.length < 3 || !row.every((part) => typeof part === "string")) return null;
    const [input, output, ...poolIds] = row as string[];
    if (!input || !output || !COSMOS_DENOM.test(input) || !COSMOS_DENOM.test(output)) return null;
    if (!poolIds.every((id) => /^[1-9]\d*$/.test(id))) return null;
    out.push({ input, output, poolIds });
  }
  return { xcsContract, swapContract, routes: out, readAt };
}

function recordOf(table: XcsRouteTable): CacheRecord {
  return {
    version: XCS_ROUTES_CACHE_VERSION,
    xcsContract: table.xcsContract,
    swapContract: table.swapContract,
    readAt: table.readAt,
    routes: table.routes.map((route) => [route.input, route.output, ...route.poolIds]),
  };
}

let memory: XcsRouteTable | null = null;

/** Session storage, or nothing in a context without it; the table then lives in memory only. */
function sessionArea() {
  try {
    return browser.storage?.session;
  } catch {
    return undefined;
  }
}

async function readSession(xcsContract: string, now: number): Promise<XcsRouteTable | null> {
  const area = sessionArea();
  if (!area) return null;
  try {
    const stored = await area.get(STORAGE_KEYS.xcsRoutes);
    return tableFromRecord(stored[STORAGE_KEYS.xcsRoutes], xcsContract, now);
  } catch {
    return null;
  }
}

async function writeSession(table: XcsRouteTable): Promise<void> {
  const area = sessionArea();
  if (!area) return;
  try {
    await area.set({ [STORAGE_KEYS.xcsRoutes]: recordOf(table) });
  } catch {
    // The table still answers from memory in this context.
  }
}

/**
 * The route table of `xcsContract` (the verified venue's address), from
 * memory or the session cache while it is under an hour old, else read live.
 *
 * Resolves `null` when the table cannot be read for any reason (reads off, an
 * unreachable LCD, a router this cannot parse): every pair is then `unknown`
 * and nothing is gated. Rejects only when `signal` aborts.
 *
 * @param options.lcd - The venue's LCD client; tests pass a stub.
 * @param options.force - Skip both caches, for a manual refresh.
 */
export async function loadXcsRoutes(
  xcsContract: string,
  options: {
    readonly signal?: AbortSignal;
    readonly force?: boolean;
    readonly lcd?: LcdClient;
    readonly now?: number;
  } = {},
): Promise<XcsRouteTable | null> {
  const contract = xcsContract.trim();
  const now = options.now ?? Date.now();
  if (!options.force) {
    if (memory && memory.xcsContract === contract && memory.readAt <= now && now - memory.readAt <= XCS_ROUTES_TTL_MS) {
      return memory;
    }
    const stored = await readSession(contract, now);
    if (stored) {
      memory = stored;
      return stored;
    }
  }
  try {
    const venue = options.lcd ? null : chainRegistry().get(VENUE);
    const lcd = options.lcd ?? (venue ? lcdFor(venue) : null);
    if (!lcd) return null;
    const table = await readRoutingTable(lcd, contract, {
      ...(options.signal ? { signal: options.signal } : {}),
      now,
    });
    memory = table;
    await writeSession(table);
    return table;
  } catch (error) {
    // A cancelled read says nothing about the table, so it is not "unknown".
    if (options.signal?.aborted) {
      throw isInterchainError(error) && error.code === "aborted"
        ? error
        : new InterchainError("aborted", `${VENUE}: route table read cancelled`, { chainId: VENUE, cause: error });
    }
    return null;
  }
}

/** Forget the in-memory table (the session copy stays). For tests and a manual refresh. */
export function resetXcsRoutesMemory(): void {
  memory = null;
}

/* -------------------------------------------------------------------------- *
 * Answers
 * -------------------------------------------------------------------------- */

const pairIndexes = new WeakMap<XcsRouteTable, ReadonlySet<string>>();

function pairsOf(table: XcsRouteTable): ReadonlySet<string> {
  let pairs = pairIndexes.get(table);
  if (!pairs) {
    pairs = new Set(table.routes.map((route) => pairKey(route.input, route.output)));
    pairIndexes.set(table, pairs);
  }
  return pairs;
}

/**
 * Whether the contract can swap `vin` into `vout`, both named as Osmosis
 * denoms. `unknown` without a table or without a name for either side.
 */
export function executable(
  table: XcsRouteTable | null | undefined,
  vin: string | null | undefined,
  vout: string | null | undefined,
): Executable {
  if (!table || !vin || !vout) return "unknown";
  return pairsOf(table).has(pairKey(vin, vout)) ? "yes" : "no";
}

const assetIndexes = new WeakMap<XcsRouteTable, ReadonlySet<string> | null>();

/**
 * The assets the table trades, as `origin chain + origin denom`, or `null`
 * when any of its denoms has no proven identity. With every denom named, an
 * asset outside this set cannot be on either side of any route.
 */
function assetsOf(table: XcsRouteTable): ReadonlySet<string> | null {
  if (assetIndexes.has(table)) return assetIndexes.get(table) ?? null;
  const assets = new Set<string>();
  let complete = true;
  for (const route of table.routes) {
    for (const denom of [route.input, route.output]) {
      const identity = identityOf(VENUE, denom);
      if (identity.provenance === "unknown" || !identity.originChainId || !identity.originDenom) {
        complete = false;
        continue;
      }
      assets.add(`${identity.originChainId}\u0000${identity.originDenom}`);
    }
  }
  const out = complete ? assets : null;
  assetIndexes.set(table, out);
  return out;
}

/** The side's denom on Osmosis: the held denom there, else the identity's canonical voucher. */
export function osmosisDenomFor(side: Pick<GateSide, "chainId" | "denom" | "identity">): string | null {
  return side.chainId === VENUE ? side.denom : side.identity.osmosisDenom;
}

/**
 * The side's name in the table's terms: its Osmosis denom; `absent` when it
 * has none and provably is none of the table's assets (Safrochain's SAF, a
 * chain coin Osmosis does not list); `unknown` when that cannot be told (an
 * unidentified token, a table with an unnamed denom, an asset the table does
 * trade under a voucher the identity does not name).
 */
function venueSide(table: XcsRouteTable, side: GateSide): string | "absent" | "unknown" {
  const denom = osmosisDenomFor(side);
  if (denom) return denom;
  const { identity } = side;
  if (identity.provenance === "unknown" || !identity.originChainId || !identity.originDenom) return "unknown";
  const assets = assetsOf(table);
  if (!assets || assets.has(`${identity.originChainId}\u0000${identity.originDenom}`)) return "unknown";
  return "absent";
}

/**
 * {@link executable} for two swap rows, from their identities. A side with no
 * Osmosis denom answers `no` only when it provably is none of the table's
 * assets, else `unknown`.
 */
export function executableBetween(
  table: XcsRouteTable | null | undefined,
  from: GateSide,
  to: GateSide,
): Executable {
  if (!table) return "unknown";
  const vin = venueSide(table, from);
  const vout = venueSide(table, to);
  if (vin === "unknown" || vout === "unknown") return "unknown";
  if (vin === "absent" || vout === "absent") return "no";
  return executable(table, vin, vout);
}

/**
 * The verdict on `option` as the To side of a swap from `from`, in order of
 * what the user can act on: a testnet side, the From row itself, the same
 * asset elsewhere, a side Osmosis does not trade. `executable` reports the
 * table alone.
 *
 * A pair the contract's table does not hold is not refused for that: Osmosis's
 * own pools swap it (lib/swap-path.ts), at once when the funds are on Osmosis,
 * after moving them there otherwise. Only the pools' one requirement refuses a
 * row on that path: both sides need a denom on Osmosis.
 */
export function gateOption(
  from: GateSide | null | undefined,
  option: GateSide,
  table: XcsRouteTable | null | undefined,
): Gate {
  if (!from) return { executable: "unknown", disabledReason: null };
  const answer = executableBetween(table, from, option);
  const gate = (disabledReason: string | null): Gate => ({ executable: answer, disabledReason });
  if (from.testnet || option.testnet) return gate(TESTNET_REASON);
  if (option.key === from.key) return gate(SELF_REASON);
  const vin = osmosisDenomFor(from);
  const vout = osmosisDenomFor(option);
  if (vin && vout && denomKey(vin) === denomKey(vout)) return gate(SAME_TOKEN_REASON);
  if (swapPathFor(from, option, answer) !== "contract" && !(vin && vout)) {
    return gate(notTradedReason((vin ? option : from).identity.ticker));
  }
  return gate(null);
}

/** {@link gateOption} over a whole To list, order kept. */
export function gateOptions<T extends GateSide>(
  from: GateSide | null | undefined,
  options: readonly T[],
  table: XcsRouteTable | null | undefined,
): (T & Gate)[] {
  return options.map((option) => ({ ...option, ...gateOption(from, option, table) }));
}
