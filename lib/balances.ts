/**
 * Optional on-chain reads.
 *
 * Balances come straight from the public REST (LCD) endpoint the chain
 * registry lists for each chain. This is opt-in: the user has to grant the
 * optional host permission, otherwise every call short-circuits and the UI
 * shows a placeholder instead of a number.
 */

import { parseDenomTrace } from "@zunialab/interchain";
import {
  catalogIconFor,
  chainTicker,
  displayCoinSymbol,
  findCurrency,
  findCatalogEntry,
} from "./chain-catalog";
import { OPTIONAL_HOST_PERMISSIONS, REALTIME_HOST_PERMISSIONS } from "../config/hosts";
import { getSettings } from "./settings";
import { STORAGE_KEYS } from "./storage-keys";

export type TokenKind = "native" | "ibc" | "factory" | "other";

/** One bank denom held by the address. */
export interface TokenBalance {
  denom: string;
  amount: string;
  kind: TokenKind;
  /** Best-effort ticker for the UI (ATOM, USDC, …). */
  symbol: string;
  /**
   * Full label shown in lists. IBC tokens use `USDC/IBC`; native tokens use
   * the ticker alone.
   */
  displayName: string;
  decimals: number;
  /** Token / asset logo when known. */
  iconUrl?: string;
  /** Underlying denom after IBC unwind (e.g. `uusdc`). */
  baseDenom?: string;
  /** IBC hop string from denom_trace, e.g. `transfer/channel-0`. */
  ibcPath?: string;
  /** Registry name of the base denom's chain, when known. */
  originChainName?: string;
}

export interface ChainBalance {
  chainId: string;
  /** Base-unit amount of the chain's staking denom. */
  available: string;
  staked: string;
  rewards: string;
  denom: string;
  decimals: number;
  symbol: string;
  /** Native token logo for list rows. */
  iconUrl?: string;
  /** Every non-zero bank balance: native, IBC, factory, and anything else. */
  tokens: TokenBalance[];
  /** Set when the endpoint was unreachable or returned garbage. */
  error?: string;
}

const CACHE_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 8_000;

/**
 * Cache schema version.
 *
 * Bumped when the shape changes so a stored record from an older build is
 * dropped whole rather than read field by field. The previous shape kept one
 * `fetchedAt` for the entire map, which was wrong as soon as anything refreshed
 * a single chain: that write moved every other chain's apparent age back to
 * zero, so a stale row could sit there for another full TTL. Ages are per entry
 * now, which is what the realtime path needs - it refreshes exactly the one
 * chain an event names.
 */
const CACHE_VERSION = 5;

interface CacheEntry {
  at: number;
  balance: ChainBalance;
}

interface CacheRecord {
  version: number;
  balances: Record<string, CacheEntry>;
}

function readCacheRecord(raw: unknown): CacheRecord {
  const stored = raw as Partial<CacheRecord> | undefined;
  if (!stored || stored.version !== CACHE_VERSION || typeof stored.balances !== "object") {
    return { version: CACHE_VERSION, balances: {} };
  }
  return { version: CACHE_VERSION, balances: stored.balances ?? {} };
}

/** Origins Chrome will still accept in permissions.request / remove. */
function declaredOptionalOrigins(candidates: readonly string[]): string[] {
  const manifest = browser.runtime.getManifest() as {
    optional_host_permissions?: string[];
  };
  const declared = new Set(manifest.optional_host_permissions ?? []);
  return candidates.filter((origin) => declared.has(origin));
}

export async function hasLiveBalancePermission(): Promise<boolean> {
  try {
    return await browser.permissions.contains({
      origins: [...OPTIONAL_HOST_PERMISSIONS],
    });
  } catch {
    return false;
  }
}

/**
 * Websocket origins, asked for with live balances but checked on their own.
 * An https grant does not cover `wss`, so realtime falls back to the poll
 * when this is missing instead of taking balances down with it.
 */
export async function hasRealtimePermission(): Promise<boolean> {
  try {
    return await browser.permissions.contains({
      origins: [...REALTIME_HOST_PERMISSIONS],
    });
  } catch {
    return false;
  }
}

/**
 * Call it before anything else is awaited in the click handler: Chrome and
 * Firefox honor a permission request only straight from the user's gesture.
 * Every browser answers at once, with no prompt, when the access is already
 * granted.
 */
export async function requestLiveBalancePermission(): Promise<boolean> {
  try {
    // Dev builds require the https wildcard (see wxt.config.ts), so it is not
    // requestable. Asking for it rejects the whole call, including the sockets.
    const origins = declaredOptionalOrigins([
      ...OPTIONAL_HOST_PERMISSIONS,
      ...REALTIME_HOST_PERMISSIONS,
    ]);
    if (origins.length > 0) {
      await browser.permissions.request({ origins });
    }
    return await hasLiveBalancePermission();
  } catch {
    return false;
  }
}

/**
 * Why live balances stayed off after the request came back false. Safari
 * answers false without a prompt: website access lives in its own settings,
 * and the request succeeds once the user allows Zunia on other websites there.
 */
export function liveBalanceRefusalNote(): string {
  if (import.meta.env.BROWSER !== "safari") {
    return "The browser did not grant access, so balances stay off.";
  }
  const touch =
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  return touch
    ? "Safari keeps this in Settings > Apps > Safari > Extensions > Zunia. Set Other Websites to Allow, then try again."
    : "Safari keeps this in its own settings. Allow Zunia on other websites there, then try again.";
}

export async function dropLiveBalancePermission(): Promise<void> {
  try {
    const origins = declaredOptionalOrigins([
      ...OPTIONAL_HOST_PERMISSIONS,
      ...REALTIME_HOST_PERMISSIONS,
    ]);
    if (origins.length === 0) return;
    await browser.permissions.remove({ origins });
  } catch {
    // Firefox refuses to drop some origins; the settings flag still wins.
  }
}

const BANK_PAGE_LIMIT = 200;
const BANK_MAX_PAGES = 10;

function nextPageKey(body: unknown): string | null {
  const page = (body as { pagination?: { next_key?: unknown; nextKey?: unknown } })
    ?.pagination;
  const key = page?.next_key ?? page?.nextKey;
  return typeof key === "string" && key.length > 0 ? key : null;
}

/** Every bank coin this address holds, following pagination so factory tokens are not dropped. */
async function fetchBankBalances(
  rest: string,
  address: string,
): Promise<Array<{ denom?: string; amount?: string }>> {
  const rows: Array<{ denom?: string; amount?: string }> = [];
  let key: string | null = null;
  for (let page = 0; page < BANK_MAX_PAGES; page++) {
    const params = new URLSearchParams({
      "pagination.limit": String(BANK_PAGE_LIMIT),
    });
    if (key) params.set("pagination.key", key);
    const body = (await getJson(
      `${rest}/cosmos/bank/v1beta1/balances/${address}?${params}`,
    )) as { balances?: Array<{ denom?: string; amount?: string }> };
    rows.push(...(body.balances ?? []));
    key = nextPageKey(body);
    if (!key) break;
  }
  return rows;
}

async function getJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      credentials: "omit",
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function sumDenom(
  rows: Array<{ denom?: string; amount?: string }> | undefined,
  denom: string,
): string {
  if (!rows) return "0";
  let total = 0n;
  for (const row of rows) {
    if (row.denom !== denom || !row.amount) continue;
    // Reward amounts are decimal strings ("12.345"); truncate to base units.
    total += BigInt(row.amount.split(".")[0] || "0");
  }
  return total.toString();
}

/** Classify a bank denom for display without a full asset registry. */
export function classifyToken(
  denom: string,
  amount: string,
  native: {
    denom: string;
    symbol: string;
    decimals: number;
    iconUrl?: string;
  },
): TokenBalance {
  if (denom === native.denom) {
    return {
      denom,
      amount,
      kind: "native",
      symbol: native.symbol,
      displayName: native.symbol,
      decimals: native.decimals,
      iconUrl: native.iconUrl,
      baseDenom: denom,
    };
  }
  if (denom.startsWith("ibc/")) {
    const hash = denom.slice(4);
    return {
      denom,
      amount,
      kind: "ibc",
      symbol: hash.slice(0, 6).toUpperCase(),
      displayName: `IBC ${hash.slice(0, 6).toUpperCase()}`,
      decimals: 6,
      // Origin logo is filled in after denom_trace; the holding chain's mark
      // stays until then so the row is never a blank circle.
      ...(native.iconUrl ? { iconUrl: native.iconUrl } : {}),
    };
  }
  if (denom.startsWith("factory/")) {
    const parts = denom.split("/");
    const sub = parts[parts.length - 1] || "TOKEN";
    const symbol = sub.length > 12 ? `${sub.slice(0, 10)}…` : sub;
    return {
      denom,
      amount,
      kind: "factory",
      symbol,
      displayName: symbol,
      decimals: 6,
      baseDenom: denom,
      ...(native.iconUrl ? { iconUrl: native.iconUrl } : {}),
    };
  }
  // Known base denoms held as local bank coins, including `erc20:` rows.
  const known = findCurrency(denom);
  if (known) {
    const symbol = displayCoinSymbol(known.currency.coinDenom, known.entry.bech32Prefix);
    return {
      denom,
      amount,
      kind: "other",
      symbol,
      displayName: symbol,
      decimals: known.currency.coinDecimals,
      iconUrl: catalogIconFor(known.entry),
      baseDenom: denom,
    };
  }
  return {
    denom,
    amount,
    kind: "other",
    symbol: denom.length > 14 ? `${denom.slice(0, 12)}…` : denom,
    displayName: denom.length > 14 ? `${denom.slice(0, 12)}…` : denom,
    decimals: 6,
    baseDenom: denom,
  };
}

function prettyBaseSymbol(baseDenom: string): string {
  // Strip common Cosmos prefixes so `uusdc` → `USDC`, `uatom` → `ATOM`.
  const stripped = baseDenom.replace(/^(u|n|a|atto)/i, "");
  if (stripped && stripped !== baseDenom && /^[a-z0-9]+$/i.test(stripped)) {
    return stripped.toUpperCase();
  }
  if (baseDenom.length <= 8) return baseDenom.toUpperCase();
  return baseDenom.slice(0, 8).toUpperCase();
}

function isUnimplementedTrace(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const rec = body as Record<string, unknown>;
  if (rec.code === 12 || rec.code === "12") return true;
  return typeof rec.message === "string" && /not implemented/i.test(rec.message);
}

/**
 * ibc-go v8 `/denom_traces/{hash}` first, then v9 `/denoms/{hash}`. Hub LCDs
 * answer the old path with gRPC 12 / HTTP 501, which used to leave IBC rows
 * as a hash prefix and no origin logo.
 */
async function fetchIbcTrace(
  rest: string,
  hash: string,
): Promise<{ baseDenom: string; path: string } | null> {
  const urls = [
    `${rest}/ibc/apps/transfer/v1/denom_traces/${hash}`,
    `${rest}/ibc/apps/transfer/v1/denoms/${hash}`,
    `${rest}/ibc/apps/transfer/v1/denoms/${encodeURIComponent(`ibc/${hash}`)}`,
  ];
  for (const url of urls) {
    try {
      const body = await getJson(url);
      if (isUnimplementedTrace(body)) continue;
      const trace = parseDenomTrace(body);
      if (trace.baseDenom) return { baseDenom: trace.baseDenom, path: trace.path };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Unwind an IBC denom via the chain's denom trace endpoint and attach the
 * registry symbol / logo when the base denom is known.
 */
async function resolveIbcToken(
  rest: string,
  token: TokenBalance,
): Promise<TokenBalance> {
  if (token.kind !== "ibc" || !token.denom.startsWith("ibc/")) return token;
  const hash = token.denom.slice(4);
  try {
    const traced = await fetchIbcTrace(rest, hash);
    if (!traced) return token;

    const base = traced.baseDenom;
    const path = traced.path;
    const known = findCurrency(base);
    if (known) {
      const symbol = displayCoinSymbol(known.currency.coinDenom, known.entry.bech32Prefix);
      return {
        ...token,
        symbol,
        displayName: `${symbol}/IBC`,
        decimals: known.currency.coinDecimals,
        iconUrl: catalogIconFor(known.entry),
        baseDenom: base,
        ...(path ? { ibcPath: path } : {}),
        originChainName: known.entry.chainName,
      };
    }

    // Fall back to bank metadata on this chain for custom / CW20-origin assets.
    const fromMeta = await readBankMetadata(rest, token.denom);
    if (fromMeta) {
      return {
        ...token,
        symbol: fromMeta.symbol,
        displayName: `${fromMeta.symbol}/IBC`,
        decimals: fromMeta.decimals,
        baseDenom: base,
        ...(path ? { ibcPath: path } : {}),
      };
    }
    const symbol = prettyBaseSymbol(base);
    return {
      ...token,
      symbol,
      displayName: `${symbol}/IBC`,
      baseDenom: base,
      ...(path ? { ibcPath: path } : {}),
    };
  } catch {
    return token;
  }
}

async function readBankMetadata(
  rest: string,
  denom: string,
): Promise<{ symbol: string; decimals: number } | null> {
  try {
    const meta = (await getJson(
      `${rest}/cosmos/bank/v1beta1/denoms_metadata/${encodeURIComponent(denom)}`,
    )) as {
      metadata?: {
        symbol?: string;
        display?: string;
        name?: string;
        denom_units?: Array<{ denom?: string; exponent?: number }>;
      };
    };
    const m = meta.metadata;
    const symbol = (m?.symbol || m?.display || m?.name || "").trim();
    if (!symbol) return null;
    const decimals =
      m?.denom_units?.reduce((max, unit) => Math.max(max, unit.exponent ?? 0), 0) ?? 6;
    return { symbol, decimals };
  } catch {
    return null;
  }
}

/** Factory and other denoms: use on-chain metadata when the chain published it. */
async function resolveHeldToken(
  rest: string,
  token: TokenBalance,
): Promise<TokenBalance> {
  if (token.kind === "ibc") return resolveIbcToken(rest, token);
  if (token.kind !== "factory" && token.kind !== "other") return token;
  const fromMeta = await readBankMetadata(rest, token.denom);
  if (!fromMeta) return token;
  return {
    ...token,
    symbol: fromMeta.symbol,
    displayName: fromMeta.symbol,
    decimals: fromMeta.decimals,
  };
}

async function enrichTokens(
  rest: string,
  tokens: TokenBalance[],
): Promise<TokenBalance[]> {
  return Promise.all(tokens.map((token) => resolveHeldToken(rest, token)));
}

function parseBankTokens(
  rows: Array<{ denom?: string; amount?: string }> | undefined,
  native: {
    denom: string;
    symbol: string;
    decimals: number;
    iconUrl?: string;
  },
): TokenBalance[] {
  if (!rows) return [];
  const tokens: TokenBalance[] = [];
  for (const row of rows) {
    if (!row.denom || !row.amount || row.amount === "0") continue;
    tokens.push(classifyToken(row.denom, row.amount, native));
  }
  // Native first, then IBC, factory, other; alphabetical within each kind.
  const order: Record<TokenKind, number> = {
    native: 0,
    ibc: 1,
    factory: 2,
    other: 3,
  };
  return tokens.sort((a, b) => {
    const byKind = order[a.kind] - order[b.kind];
    if (byKind !== 0) return byKind;
    return a.displayName.localeCompare(b.displayName);
  });
}

async function fetchChainBalance(
  chainId: string,
  address: string,
): Promise<ChainBalance> {
  const entry = findCatalogEntry(chainId);
  const iconUrl = entry ? catalogIconFor(entry) : undefined;
  const native = {
    denom: entry?.coinMinimalDenom ?? "",
    symbol: entry ? chainTicker(entry) : chainId,
    decimals: entry?.coinDecimals ?? 6,
    iconUrl,
  };
  const base: ChainBalance = {
    chainId,
    available: "0",
    staked: "0",
    rewards: "0",
    denom: native.denom,
    decimals: native.decimals,
    symbol: native.symbol,
    iconUrl,
    tokens: [],
  };
  const rest = entry?.rest?.replace(/\/$/, "");
  if (!rest) return { ...base, error: "No REST endpoint in the registry" };

  const denom = native.denom;
  const [bank, staking, rewards] = await Promise.allSettled([
    fetchBankBalances(rest, address),
    getJson(`${rest}/cosmos/staking/v1beta1/delegations/${address}`),
    getJson(
      `${rest}/cosmos/distribution/v1beta1/delegators/${address}/rewards`,
    ),
  ]);

  if (bank.status === "rejected") {
    return { ...base, error: "Endpoint unreachable" };
  }

  const bankRows = bank.value;
  const stakedRows =
    staking.status === "fulfilled"
      ? (
          staking.value as {
            delegation_responses?: Array<{
              balance?: { denom?: string; amount?: string };
            }>;
          }
        ).delegation_responses?.map((d) => d.balance ?? {})
      : undefined;
  const rewardRows =
    rewards.status === "fulfilled"
      ? (rewards.value as { total?: Array<{ denom?: string; amount?: string }> })
          .total
      : undefined;

  const tokens = await enrichTokens(
    rest,
    parseBankTokens(bankRows, native),
  );

  return {
    ...base,
    available: sumDenom(bankRows, denom),
    staked: sumDenom(stakedRows, denom),
    rewards: sumDenom(rewardRows, denom),
    tokens,
  };
}

async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i]!, i);
    }
  }
  const agents = Array.from(
    { length: Math.min(concurrency, Math.max(items.length, 1)) },
    () => run(),
  );
  await Promise.all(agents);
  return results;
}

/**
 * Balances for the given chains, cached for a minute so switching tabs in the
 * popup does not re-hit every endpoint.
 */
export async function getChainBalances(
  accounts: Array<{ chainId: string; address: string }>,
  options: { force?: boolean } = {},
): Promise<ChainBalance[]> {
  const settings = await getSettings();
  if (!settings.liveBalances || !(await hasLiveBalancePermission())) {
    return [];
  }

  // Placeholder / failed derives have no address; skip instead of spamming
  // LCD with `/balances/` and poisoning the cache.
  const usable = accounts.filter((a) => a.address.trim().length > 0);
  if (usable.length === 0) return [];

  const cached = readCacheRecord(
    (await browser.storage.local.get(STORAGE_KEYS.balanceCache))[
      STORAGE_KEYS.balanceCache
    ],
  );
  const now = Date.now();

  /** A cached row still worth serving for this account, or null. */
  const liveEntry = (key: string): ChainBalance | null => {
    if (options.force) return null;
    const entry = cached.balances[key];
    if (!entry || now - entry.at >= CACHE_TTL_MS) return null;
    // Older caches predate IBC display names and logos; treat them as missing
    // so one refresh upgrades them rather than pinning the old rendering.
    const tokens = entry.balance?.tokens;
    if (!Array.isArray(tokens)) return null;
    if (!tokens.every((token) => typeof token.displayName === "string")) return null;
    return entry.balance;
  };

  // Only the accounts whose row actually expired are fetched. Previously a
  // single stale chain re-fetched every chain, which is what made a manual
  // refresh cost a dozen round trips instead of one.
  const hits = new Map<string, ChainBalance>();
  const misses: Array<{ chainId: string; address: string }> = [];
  for (const account of usable) {
    const key = `${account.chainId}:${account.address}`;
    const hit = liveEntry(key);
    if (hit) hits.set(key, hit);
    else misses.push(account);
  }

  if (misses.length > 0) {
    // Cap fan-out: Select-all networks previously opened hundreds of LCD calls
    // at once, which starved the MV3 worker and left the popup with no balances.
    const fetched = await mapPool(misses, 6, async (a) =>
      fetchChainBalance(a.chainId, a.address).catch(
        (err: unknown): ChainBalance => ({
          chainId: a.chainId,
          available: "0",
          staked: "0",
          rewards: "0",
          denom: "",
          decimals: 6,
          symbol: a.chainId,
          tokens: [],
          error: err instanceof Error ? err.message : "Request failed",
        }),
      ),
    );
    const at = Date.now();
    misses.forEach((a, i) => {
      const key = `${a.chainId}:${a.address}`;
      const balance = fetched[i]!;
      hits.set(key, balance);
      // A failed read is cached too, with its error, so a chain whose endpoint
      // is down does not get re-tried on every render. It ages out like any
      // other row, and `force` skips it.
      cached.balances[key] = { at, balance };
    });
    await browser.storage.local.set({ [STORAGE_KEYS.balanceCache]: cached });
  }

  return usable.map((a) => hits.get(`${a.chainId}:${a.address}`)!);
}

/**
 * One chain, always from the network, with the cache updated.
 *
 * The realtime engine's entry point: a socket event names exactly one chain, so
 * this refreshes exactly that one. Going through `getChainBalances` with
 * `force` would work, but only because the caller happens to pass a single
 * account; naming the intent keeps the next caller from passing a list and
 * quietly re-fetching everything on every block.
 */
export async function refreshChainBalance(account: {
  chainId: string;
  address: string;
}): Promise<ChainBalance | null> {
  const [row] = await getChainBalances([account], { force: true });
  return row ?? null;
}

export async function clearBalanceCache(): Promise<void> {
  await browser.storage.local.remove(STORAGE_KEYS.balanceCache);
}
