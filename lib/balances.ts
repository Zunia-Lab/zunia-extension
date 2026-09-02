/**
 * Optional on-chain reads.
 *
 * Balances come straight from the public REST (LCD) endpoint the chain
 * registry lists for each chain. This is opt-in: the user has to grant the
 * optional host permission from Settings, otherwise every call short-circuits
 * and the UI shows an em dash instead of a number.
 */

import {
  catalogIconFor,
  findCatalogByMinimalDenom,
  findCatalogEntry,
} from "./chain-catalog";
import { OPTIONAL_HOST_PERMISSIONS } from "../config/hosts";
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

interface CacheRecord {
  fetchedAt: number;
  balances: Record<string, ChainBalance>;
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

export async function requestLiveBalancePermission(): Promise<boolean> {
  try {
    return await browser.permissions.request({
      origins: [...OPTIONAL_HOST_PERMISSIONS],
    });
  } catch {
    return false;
  }
}

export async function dropLiveBalancePermission(): Promise<void> {
  try {
    await browser.permissions.remove({
      origins: [...OPTIONAL_HOST_PERMISSIONS],
    });
  } catch {
    // Firefox refuses to drop some origins; the settings flag still wins.
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
    };
  }
  // Known base denoms held as local bank coins (rare, but cheap to resolve).
  const known = findCatalogByMinimalDenom(denom);
  if (known) {
    return {
      denom,
      amount,
      kind: "other",
      symbol: known.coinDenom,
      displayName: known.coinDenom,
      decimals: known.coinDecimals,
      iconUrl: catalogIconFor(known),
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

/**
 * Unwind an IBC denom via the chain's denom_trace endpoint and attach the
 * registry symbol / logo when the base denom is known.
 */
async function resolveIbcToken(
  rest: string,
  token: TokenBalance,
): Promise<TokenBalance> {
  if (token.kind !== "ibc" || !token.denom.startsWith("ibc/")) return token;
  const hash = token.denom.slice(4);
  try {
    const body = (await getJson(
      `${rest}/ibc/apps/transfer/v1/denom_traces/${hash}`,
    )) as {
      denom_trace?: { path?: string; base_denom?: string };
    };
    const base = body.denom_trace?.base_denom?.trim();
    if (!base) return token;

    const known = findCatalogByMinimalDenom(base);
    if (known) {
      return {
        ...token,
        symbol: known.coinDenom,
        displayName: `${known.coinDenom}/IBC`,
        decimals: known.coinDecimals,
        iconUrl: catalogIconFor(known),
        baseDenom: base,
      };
    }

    // Fall back to bank metadata on this chain for custom / CW20-origin assets.
    try {
      const meta = (await getJson(
        `${rest}/cosmos/bank/v1beta1/denoms_metadata/${encodeURIComponent(token.denom)}`,
      )) as {
        metadata?: {
          symbol?: string;
          display?: string;
          name?: string;
          denom_units?: Array<{ denom?: string; exponent?: number }>;
        };
      };
      const m = meta.metadata;
      const symbol =
        (m?.symbol || m?.display || m?.name || prettyBaseSymbol(base)).trim();
      const decimals =
        m?.denom_units?.reduce(
          (max, unit) => Math.max(max, unit.exponent ?? 0),
          0,
        ) ?? 6;
      return {
        ...token,
        symbol,
        displayName: `${symbol}/IBC`,
        decimals,
        baseDenom: base,
      };
    } catch {
      const symbol = prettyBaseSymbol(base);
      return {
        ...token,
        symbol,
        displayName: `${symbol}/IBC`,
        baseDenom: base,
      };
    }
  } catch {
    return token;
  }
}

async function enrichTokens(
  rest: string,
  tokens: TokenBalance[],
): Promise<TokenBalance[]> {
  return Promise.all(
    tokens.map((token) =>
      token.kind === "ibc" ? resolveIbcToken(rest, token) : Promise.resolve(token),
    ),
  );
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
  // Native first, then IBC, factory, other — alphabetical within each kind.
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
    symbol: entry?.coinDenom ?? chainId,
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
    getJson(`${rest}/cosmos/bank/v1beta1/balances/${address}`),
    getJson(`${rest}/cosmos/staking/v1beta1/delegations/${address}`),
    getJson(
      `${rest}/cosmos/distribution/v1beta1/delegators/${address}/rewards`,
    ),
  ]);

  if (bank.status === "rejected") {
    return { ...base, error: "Endpoint unreachable" };
  }

  const bankBody = bank.value as {
    balances?: Array<{ denom?: string; amount?: string }>;
  };
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
    parseBankTokens(bankBody.balances, native),
  );

  return {
    ...base,
    available: sumDenom(bankBody.balances, denom),
    staked: sumDenom(stakedRows, denom),
    rewards: sumDenom(rewardRows, denom),
    tokens,
  };
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

  const cached = (
    await browser.storage.local.get(STORAGE_KEYS.balanceCache)
  )[STORAGE_KEYS.balanceCache] as CacheRecord | undefined;
  const fresh =
    !options.force &&
    cached &&
    Date.now() - cached.fetchedAt < CACHE_TTL_MS &&
    accounts.every((a) => {
      const hit = cached.balances[`${a.chainId}:${a.address}`];
      // Refresh when older cache entries lack IBC display names / logos.
      return (
        hit &&
        Array.isArray(hit.tokens) &&
        // New schema always sets displayName; older caches omit it.
        hit.tokens.every((token) => typeof token.displayName === "string")
      );
    });
  if (fresh && cached) {
    return accounts.map((a) => cached.balances[`${a.chainId}:${a.address}`]!);
  }

  const results = await Promise.all(
    accounts.map((a) =>
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
    ),
  );

  const map: Record<string, ChainBalance> = {};
  accounts.forEach((a, i) => {
    map[`${a.chainId}:${a.address}`] = results[i]!;
  });
  await browser.storage.local.set({
    [STORAGE_KEYS.balanceCache]: {
      fetchedAt: Date.now(),
      balances: { ...cached?.balances, ...map },
    } satisfies CacheRecord,
  });
  return results;
}

export async function clearBalanceCache(): Promise<void> {
  await browser.storage.local.remove(STORAGE_KEYS.balanceCache);
}
