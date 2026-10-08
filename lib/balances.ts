/**
 * Optional on-chain reads.
 *
 * Balances come straight from the public REST (LCD) endpoint the chain
 * registry lists for each chain. This is opt-in: the user has to grant the
 * optional host permission, otherwise every call short-circuits and the UI
 * shows a placeholder instead of a number.
 *
 * Every held denom is named by its TokenIdentity (lib/token-identity.ts), never
 * here: an `ibc/` voucher by its hash-verified trace, so Noble USDC on Osmosis
 * reads `USDC.n` and not whichever catalog chain lists `uusdc` first. This file
 * only reads the chain and copies the identity onto the row.
 */

import {
  catalogIconFor,
  chainTicker,
  findCatalogEntry,
} from "./chain-catalog";
import { OPTIONAL_HOST_PERMISSIONS, REALTIME_HOST_PERMISSIONS } from "../config/hosts";
import { getSettings } from "./settings";
import { STORAGE_KEYS } from "./storage-keys";
import {
  hydrateTokenIdentities,
  identifyHeld,
  identityOf,
  type TokenIdentity,
  type TokenKind as IdentityKind,
} from "./token-identity";

/**
 * How Home groups a row. `native` is the chain's staking coin only; a fee coin,
 * an erc20, peggy or cw20 denom is `other`. The finer kind is on the identity.
 */
export type TokenKind = "native" | "ibc" | "factory" | "other";

/**
 * One bank denom held by the address, named by its TokenIdentity. The field
 * names predate identities and are kept; the identity fields are optional so
 * rows built by hand elsewhere (Send's and Home's native placeholders) still
 * type-check. A screen shows a row through {@link heldTokenIdentity}, which
 * gives the badge, the text and the accessible name, and the decimals the
 * amount is shown and typed with.
 */
export interface TokenBalance {
  /** The exact bank denom, never case-folded. */
  denom: string;
  amount: string;
  kind: TokenKind;
  /** The identity's ticker: `USDC.n`, `ATOM`, `IBC·498A`. Never from bank metadata. */
  symbol: string;
  /**
   * The label lists show: the ticker, the same as `symbol`. Where the token is
   * held is shown apart (a chain badge, "on Osmosis"), never as `USDC/IBC`.
   */
  displayName: string;
  /** Display exponent. 0 when `decimalsKnown` is false: the amount is then base units. */
  decimals: number;
  /**
   * False when nothing proves the exponent. The amount is shown in base units
   * and only Max may be sent: a typed amount cannot be converted. True for the
   * catalog, the token table, or, for a token whose identity is unknown, the
   * chain's own bank metadata. Absent only on rows built by hand from catalog
   * natives, whose decimals are known.
   */
  decimalsKnown?: boolean;
  /**
   * The token's own logo. Never the holding chain's logo, except on the
   * chain's own coin. Absent when there is none: show a monogram.
   */
  iconUrl?: string;
  /** The exact denom on the origin chain (`uusdc`, `erc20:0xa00C…`), when the origin is known. */
  baseDenom?: string;
  /** IBC trace path on the holding chain, e.g. `transfer/channel-750`. */
  ibcPath?: string;
  /** The issuer chain, when the identity knows it. */
  originChainId?: string;
  /** The issuer chain's name, when the identity knows it. */
  originChainName?: string;
  /**
   * The identity is proven (registry, token table or a canonical channel
   * walk): the only reason to show a seal. Absent means not proven.
   */
  proven?: boolean;
  /**
   * `Noble USDC`, `Unlisted Osmosis token`, `Unknown token`. For a token whose
   * identity is unknown, the name the chain's metadata gives it, if any.
   */
  name?: string;
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
 *
 * 6: rows are named by TokenIdentity and carry `decimalsKnown`, `proven` and
 * the origin. A version-5 row would show `USDC.axl/IBC` for Noble USDC, with a
 * guessed 6 decimals, until it aged out.
 */
const CACHE_VERSION = 6;

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
    if (
      await browser.permissions.contains({
        origins: [...OPTIONAL_HOST_PERMISSIONS],
      })
    ) {
      return true;
    }
  } catch {
    // Safari throws or reports false for this grant. The Websites pane is the
    // real switch there, and it stays Allow after permissions.remove.
    return import.meta.env.BROWSER === "safari";
  }
  return import.meta.env.BROWSER === "safari";
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
  } catch {
    // Safari answers false, with no prompt, once Other Websites is already
    // Allow. The click is the consent. The Websites pane already granted the
    // hosts.
    if (import.meta.env.BROWSER === "safari") return true;
    return false;
  }
  if (import.meta.env.BROWSER === "safari") return true;
  return await hasLiveBalancePermission();
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
    : "Safari keeps this in Settings, Websites, Zunia. Set For other websites to Allow, then try again.";
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

/** A node that answered, with a status other than 2xx. */
class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
    this.name = "HttpError";
  }
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
    if (!res.ok) throw new HttpError(res.status);
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

/* -------------------------------------------------------------------------- *
 * Naming held tokens
 * -------------------------------------------------------------------------- */

/** The chain's own coin as the catalog lists it, which the chain-level row also shows. */
export interface NativeCoin {
  denom: string;
  symbol: string;
  decimals: number;
  iconUrl?: string;
  /** The holding chain, where each denom's identity is looked up. */
  chainId?: string;
}

/**
 * What a chain's bank metadata says on purpose about a denom: the decimals and
 * a name, never a ticker. A token's creator or the chain's governance writes
 * it, so `USDC` there proves nothing; Injective's own USDC reads just `USDC`,
 * the same text as Osmosis's alloy.
 */
export interface BankMetadataFacts {
  readonly name: string | null;
  readonly decimals: number | null;
}

function balanceKind(kind: IdentityKind): TokenKind {
  if (kind === "ibc" || kind === "factory") return kind;
  // The staking coin is matched before this; a fee coin, erc20, peggy and
  // cw20 denoms group with everything else.
  return "other";
}

/**
 * A denom read with no chain to look it up on has no identity at all, so the
 * row can only repeat what the denom spells out: a factory denom's subdenom,
 * as rows read before identities. That text is its creator's and is never
 * proven. The balance reader always names the chain and never comes here.
 */
function chainlessTicker(identity: TokenIdentity): string | null {
  if (identity.heldOnChainId || identity.kind !== "factory") return null;
  return identity.denom.split("/").pop() || null;
}

/**
 * One bank row, named by its identity (lib/token-identity.ts).
 *
 * The chain's own coin keeps the ticker and decimals the chain-level row shows
 * (`chainTicker`, the catalog's exponent), so the two never disagree; its
 * identity adds the logo, the origin and the seal. Every other denom takes its
 * ticker, name, decimals, logo and origin from the identity alone. Bank
 * metadata counts only when the identity is unknown, and then only for the
 * decimals and the name: a named token whose decimals are unknown (allSHIB,
 * where the catalog and Osmosis disagree) stays unknown, and an unlisted
 * token keeps its hash-tagged ticker. With no decimals the amount stays in
 * base units (`decimals` 0, `decimalsKnown` false); nothing guesses 6.
 *
 * `known.identity` defaults to `identityOf(native.chainId, denom)`.
 */
export function classifyToken(
  denom: string,
  amount: string,
  native: NativeCoin,
  known: { identity?: TokenIdentity; metadata?: BankMetadataFacts | null } = {},
): TokenBalance {
  const identity = known.identity ?? identityOf(native.chainId ?? "", denom);
  const unknown = identity.provenance === "unknown";
  const origin = {
    ...(identity.originChainId ? { originChainId: identity.originChainId } : {}),
    ...(identity.originChainName ? { originChainName: identity.originChainName } : {}),
  };
  if (denom === native.denom) {
    const iconUrl = identity.logoUrl ?? native.iconUrl;
    return {
      denom,
      amount,
      kind: "native",
      symbol: native.symbol,
      displayName: native.symbol,
      decimals: native.decimals,
      decimalsKnown: true,
      ...(iconUrl ? { iconUrl } : {}),
      baseDenom: denom,
      ...origin,
      proven: identity.proven,
      ...(unknown ? {} : { name: identity.name }),
    };
  }
  const metadata = unknown ? (known.metadata ?? null) : null;
  const decimals = unknown
    ? (metadata?.decimals ?? null)
    : identity.decimalsKnown
      ? identity.decimals
      : null;
  const ticker = chainlessTicker(identity) ?? identity.ticker;
  return {
    denom,
    amount,
    kind: balanceKind(identity.kind),
    symbol: ticker,
    displayName: ticker,
    decimals: decimals ?? 0,
    decimalsKnown: decimals !== null,
    ...(identity.logoUrl ? { iconUrl: identity.logoUrl } : {}),
    ...(identity.originDenom ? { baseDenom: identity.originDenom } : {}),
    ...(identity.path ? { ibcPath: identity.path } : {}),
    ...origin,
    proven: identity.proven,
    name: metadata?.name ?? identity.name,
  };
}

/**
 * The identity a held row is shown with: `identityOf(chainId, token.denom)`
 * for its ticker, badge, seal and accessible name, and the row's own decimals
 * when nothing names the token but the chain's metadata gave them (or, for
 * the chain's own coin, the catalog). That is the rule the row and Swap's sell
 * list already follow, so an amount reads, and a typed one converts, the same
 * on every surface. A named token keeps its identity's decimals, known or not:
 * a row cannot make allSHIB's disputed exponent known.
 *
 * Pass the identity to `formatTokenAmount` and `canTypeAmount`. A row built by
 * hand without `decimalsKnown` counts as known, as {@link TokenBalance} says.
 */
export function heldTokenIdentity(
  chainId: string,
  token: Pick<TokenBalance, "denom" | "decimals" | "decimalsKnown">,
): TokenIdentity {
  const identity = identityOf(chainId, token.denom);
  if (identity.provenance !== "unknown" || identity.decimalsKnown) return identity;
  const decimals = token.decimals;
  const usable = token.decimalsKnown !== false && Number.isInteger(decimals) && decimals >= 0 && decimals <= MAX_DECIMALS;
  return usable ? { ...identity, decimals, decimalsKnown: true } : identity;
}

/**
 * How long a balance read waits for token identification. Lookups that take
 * longer keep running and store what they prove, so the next read names those
 * tokens instead of this one waiting on a slow node.
 */
const IDENTIFY_WAIT_MS = 8_000;

/** The last identification queued per chain; each waits for the one before. */
const identifying = new Map<string, Promise<void>>();
let identitiesLoaded: Promise<void> | null = null;

/**
 * Wait for `work` at most `ms`. True when it settled in time; false when the
 * caller goes on without it while it keeps running.
 */
async function settleWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = work.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const elapsed = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([done, elapsed]);
  } finally {
    clearTimeout(timer);
  }
  return settled;
}

/**
 * Every held denom's identity, from one `identifyHeld` call per chain read.
 * It asks only about vouchers that neither the token table nor the catalog
 * names, at most 32 per call, and never again about one it proved or failed
 * to trace in the last half hour, so each unknown voucher costs one lookup.
 *
 * Calls for one chain run one after another: a read that starts while another
 * read of the same chain is still asking waits for it, and then finds those
 * vouchers answered instead of asking about them a second time.
 *
 * The stored facts are loaded first, once per context: the worker boots
 * without awaiting them, and a voucher proven last session must not be looked
 * up again. That load is part of the wait too, so storage that never answers
 * costs a read the stored names, not its balances.
 *
 * `settled` is false when the read stopped waiting, so some names may still
 * be on their way.
 */
async function identitiesFor(
  chainId: string,
  denoms: readonly string[],
): Promise<{ identities: ReadonlyMap<string, TokenIdentity>; settled: boolean }> {
  // Kept for the life of the context, so it must never be a rejection; bounded
  // so that one stuck storage read cannot hold every later identification.
  identitiesLoaded ??= settleWithin(
    hydrateTokenIdentities().catch(() => undefined),
    IDENTIFY_WAIT_MS,
  ).then(() => undefined);
  const loaded = identitiesLoaded;
  const previous = identifying.get(chainId) ?? Promise.resolve();
  const run: Promise<void> = previous
    .then(() => loaded)
    .then(() => identifyHeld(chainId, denoms))
    .then(
      () => undefined,
      () => undefined,
    )
    .finally(() => {
      if (identifying.get(chainId) === run) identifying.delete(chainId);
    });
  identifying.set(chainId, run);
  const settled = await settleWithin(run, IDENTIFY_WAIT_MS);
  return {
    identities: new Map(denoms.map((denom) => [denom, identityOf(chainId, denom)])),
    settled,
  };
}

/* -------------------------------------------------------------------------- *
 * Bank metadata, for tokens nothing else names
 * -------------------------------------------------------------------------- */

/** Metadata changes by governance, not by block: an answer is asked again after this long. */
const METADATA_TTL_MS = 30 * 60_000;
/** A read that failed (timeout, 5xx, rate limit) is not tried again before this. */
const METADATA_RETRY_MS = 60_000;
/**
 * How long a balance read waits for metadata. Reads still running then keep
 * going and fill the memo, so a slow node delays some decimals by one read
 * instead of holding every chain's balances.
 */
const METADATA_WAIT_MS = 3_000;
const METADATA_MAX = 1_000;
/** Unknown tokens are few, but an airdrop of junk vouchers must not fan out. */
const METADATA_CONCURRENCY = 4;
/** Exponents past this are not a token's decimals but a broken record. */
const MAX_DECIMALS = 30;

/**
 * The last answer per `${chainId}:${denom}`. Kept past its TTL until a new
 * answer replaces it: a refresh that fails must not turn known decimals back
 * into base units.
 */
const metadataMemo = new Map<string, { at: number; facts: BankMetadataFacts | null }>();
/** When the last read failed, per `${chainId}:${denom}`. */
const metadataFailedAt = new Map<string, number>();
/** Reads in flight, so two balance reads of one chain never ask twice. */
const metadataPending = new Map<string, Promise<void>>();

/**
 * Statuses meaning "not this way": no metadata for the denom (404), or a node
 * that does not serve this route or this spelling of the denom (400, 405, 501).
 */
const ABSENT_STATUSES: ReadonlySet<number> = new Set([400, 404, 405, 501]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function exponentOf(value: unknown): number | null {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof parsed === "number" && Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_DECIMALS
    ? parsed
    : null;
}

/**
 * One line of plain text: no control or bidi characters, at most 64
 * characters, cut between characters rather than inside a surrogate pair.
 */
function cleanName(value: string): string | null {
  const text = value.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const chars = Array.from(text);
  return chars.length > 64 ? `${chars.slice(0, 63).join("")}…` : text;
}

/**
 * The decimals and name a metadata record states on purpose, or `undefined`
 * when the record is another denom's.
 *
 * ibc-go writes a record for every voucher it mints: description `IBC token
 * from <path>`, display the path, name `<path> IBC token`, symbol the
 * upper-cased base (`UUSDC`) and one unit at exponent 0. None of it names the
 * token, and an exponent of 0 says nothing about decimals, so such a record
 * yields nothing unless the chain amended it (Injective adds the exponent as a
 * second unit and as `decimals`). Decimals need a positive exponent on the
 * display unit, or Injective's `decimals` field.
 *
 * The chain keys every record by its `base`, so a record whose base is not
 * the denom asked about came from a node or cache that mixed up its answers
 * (a proxy keyed on the path alone serves one record for every query string).
 * Its decimals would convert a typed amount at another token's scale.
 */
function metadataFacts(body: unknown, denom: string): BankMetadataFacts | undefined {
  const meta = asRecord(asRecord(body)?.metadata);
  if (!meta) return { name: null, decimals: null };
  const base = textOf(meta.base);
  if (base && base !== denom) return undefined;
  const display = textOf(meta.display).toLowerCase();
  const name = textOf(meta.name);
  const generated = /^IBC token from /i.test(textOf(meta.description)) || /\bIBC token$/i.test(name);
  let decimals: number | null = null;
  const units = Array.isArray(meta.denom_units) ? meta.denom_units : [];
  for (const raw of units) {
    const unit = asRecord(raw);
    if (!unit || !display) continue;
    const aliases = Array.isArray(unit.aliases) ? unit.aliases : [];
    const names = [unit.denom, ...aliases].map((alias) => textOf(alias).toLowerCase());
    if (!names.includes(display)) continue;
    decimals = exponentOf(unit.exponent);
    break;
  }
  return {
    name: generated ? null : cleanName(name),
    decimals: decimals ?? exponentOf(meta.decimals),
  };
}

/**
 * The chain's bank metadata for one denom: its facts, `null` when it has
 * none, or `undefined` when the node could not be asked or answered for
 * another denom (tried again later). A denom with `/` (`ibc/…`, `factory/…`)
 * goes through the query-string route first: the path route answers 501 for
 * those on the Osmosis and Injective LCDs.
 */
async function readBankMetadata(
  rest: string,
  denom: string,
): Promise<BankMetadataFacts | null | undefined> {
  const byPath = `${rest}/cosmos/bank/v1beta1/denoms_metadata/${encodeURIComponent(denom)}`;
  const byQuery = `${rest}/cosmos/bank/v1beta1/denoms_metadata_by_query_string?${new URLSearchParams({ denom })}`;
  for (const url of denom.includes("/") ? [byQuery, byPath] : [byPath]) {
    try {
      return metadataFacts(await getJson(url), denom);
    } catch (error) {
      if (error instanceof HttpError && ABSENT_STATUSES.has(error.status)) continue;
      return undefined;
    }
  }
  return null;
}

/** Read one denom's metadata into the memo, or note that the read failed. */
async function refreshMetadata(chainId: string, rest: string, denom: string): Promise<void> {
  const key = `${chainId}:${denom}`;
  const facts = await readBankMetadata(rest, denom);
  if (facts === undefined) {
    if (metadataFailedAt.size >= METADATA_MAX) metadataFailedAt.clear();
    metadataFailedAt.set(key, Date.now());
    return;
  }
  metadataFailedAt.delete(key);
  if (metadataMemo.size >= METADATA_MAX) metadataMemo.clear();
  metadataMemo.set(key, { at: Date.now(), facts });
}

/**
 * Metadata for denoms whose identity is unknown: each asked at most once per
 * half hour, or once a minute while its reads fail, and never twice at once.
 * The read waits {@link METADATA_WAIT_MS} at most; answers that land later
 * are in the memo for the next read. `settled` is false when it stopped
 * waiting.
 */
async function metadataFor(
  chainId: string,
  rest: string,
  denoms: readonly string[],
): Promise<{ facts: ReadonlyMap<string, BankMetadataFacts | null>; settled: boolean }> {
  const now = Date.now();
  const waits: Promise<void>[] = [];
  const ask: string[] = [];
  for (const denom of new Set(denoms)) {
    const key = `${chainId}:${denom}`;
    const pending = metadataPending.get(key);
    if (pending) {
      waits.push(pending);
      continue;
    }
    const hit = metadataMemo.get(key);
    if (hit && now - hit.at < METADATA_TTL_MS) continue;
    const failed = metadataFailedAt.get(key);
    if (failed !== undefined && now - failed < METADATA_RETRY_MS) continue;
    ask.push(denom);
  }
  if (ask.length > 0) {
    const batch = mapPool(ask, METADATA_CONCURRENCY, (denom) => refreshMetadata(chainId, rest, denom)).then(
      () => undefined,
      () => undefined,
    );
    for (const denom of ask) metadataPending.set(`${chainId}:${denom}`, batch);
    void batch.then(() => {
      for (const denom of ask) {
        const key = `${chainId}:${denom}`;
        if (metadataPending.get(key) === batch) metadataPending.delete(key);
      }
    });
    waits.push(batch);
  }
  const settled = waits.length === 0 || (await settleWithin(Promise.all(waits), METADATA_WAIT_MS));
  const facts = new Map<string, BankMetadataFacts | null>();
  for (const denom of denoms) {
    const hit = metadataMemo.get(`${chainId}:${denom}`);
    if (hit) facts.set(denom, hit.facts);
  }
  return { facts, settled };
}

/** Non-zero bank rows, as the chain spelled them. */
function heldRows(
  rows: Array<{ denom?: string; amount?: string }> | undefined,
): Array<{ denom: string; amount: string }> {
  const out: Array<{ denom: string; amount: string }> = [];
  for (const row of rows ?? []) {
    if (!row.denom || !row.amount || row.amount === "0") continue;
    out.push({ denom: row.denom, amount: row.amount });
  }
  return out;
}

function parseBankTokens(
  rows: ReadonlyArray<{ denom: string; amount: string }>,
  native: NativeCoin,
  identities: ReadonlyMap<string, TokenIdentity>,
  metadata: ReadonlyMap<string, BankMetadataFacts | null>,
): TokenBalance[] {
  const tokens = rows.map((row) => {
    const identity = identities.get(row.denom);
    return classifyToken(row.denom, row.amount, native, {
      ...(identity ? { identity } : {}),
      metadata: metadata.get(row.denom) ?? null,
    });
  });
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

/**
 * Reads that stopped waiting for names or decimals still on their way. Such a
 * row is shown, but not served again from the cache: the next read asks the
 * chain once more and picks up what has landed, instead of pinning `IBC·498A`
 * for a minute.
 */
const provisional = new WeakSet<ChainBalance>();

async function fetchChainBalance(
  chainId: string,
  address: string,
): Promise<ChainBalance> {
  const entry = findCatalogEntry(chainId);
  const iconUrl = entry ? catalogIconFor(entry) : undefined;
  const native: NativeCoin = {
    chainId,
    denom: entry?.coinMinimalDenom ?? "",
    symbol: entry ? chainTicker(entry) : chainId,
    decimals: entry?.coinDecimals ?? 6,
    ...(iconUrl ? { iconUrl } : {}),
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

  // One identification for the whole chain, then metadata only for what it
  // could not name: a known token never costs a request here.
  const held = heldRows(bankRows);
  const named = await identitiesFor(
    chainId,
    held.map((row) => row.denom),
  );
  const unnamed = held
    .map((row) => row.denom)
    .filter(
      (heldDenom) =>
        heldDenom !== denom && named.identities.get(heldDenom)?.provenance === "unknown",
    );
  const metadata = await metadataFor(chainId, rest, unnamed);
  const tokens = parseBankTokens(held, native, named.identities, metadata.facts);

  const balance: ChainBalance = {
    ...base,
    available: sumDenom(bankRows, denom),
    staked: sumDenom(stakedRows, denom),
    rewards: sumDenom(rewardRows, denom),
    tokens,
  };
  if (!named.settled || !metadata.settled) provisional.add(balance);
  return balance;
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
    // A row without identity fields predates TokenIdentity; treat it as
    // missing so one refresh upgrades it rather than pinning the old label.
    const tokens = entry.balance?.tokens;
    if (!Array.isArray(tokens)) return null;
    const named = (token: TokenBalance) =>
      typeof token.displayName === "string" && typeof token.decimalsKnown === "boolean";
    if (!tokens.every(named)) return null;
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
      // other row, and `force` skips it. A provisional read is stored already
      // expired: it still replaces an older row, but the next read refetches.
      cached.balances[key] = { at: provisional.has(balance) ? 0 : at, balance };
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
