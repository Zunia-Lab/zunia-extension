import { SECURITY_CONFIG } from "../config/security";
import { STORAGE_KEYS } from "./storage-keys";

export interface OriginGrant {
  origin: string;
  chainIds: string[];
  /** Epoch ms; null means no expiry. */
  expiresAt: number | null;
  createdAt: number;
  /** Last time the site used the grant: a key read, a signature, a reconnect. */
  lastUsedAt: number | null;
  /** The address each chain handed to the site, keyed by chain id. */
  accounts: Record<string, string>;
}

export type PermissionStore = Record<string, OriginGrant>;

/** A use closer than this to the last recorded one is not written again. */
const TOUCH_INTERVAL_MS = 60_000;

function now(): number {
  return Date.now();
}

export function isGrantActive(grant: OriginGrant, at = now()): boolean {
  if (grant.expiresAt != null && grant.expiresAt <= at) return false;
  return true;
}

export function grantAllowsChain(grant: OriginGrant, chainId: string): boolean {
  return grant.chainIds.includes(chainId) || grant.chainIds.includes("*");
}

/** A stored grant in today's shape. Grants saved before usage was tracked have none. */
function normalizeGrant(origin: string, raw: unknown): OriginGrant | null {
  if (!raw || typeof raw !== "object") return null;
  const grant = raw as Partial<OriginGrant>;
  if (!Array.isArray(grant.chainIds)) return null;
  const chainIds = grant.chainIds.filter((id): id is string => typeof id === "string");
  const accounts: Record<string, string> = {};
  if (grant.accounts && typeof grant.accounts === "object") {
    for (const [chainId, address] of Object.entries(grant.accounts)) {
      if (typeof address === "string" && chainIds.includes(chainId)) accounts[chainId] = address;
    }
  }
  return {
    origin,
    chainIds,
    expiresAt: typeof grant.expiresAt === "number" ? grant.expiresAt : null,
    createdAt: typeof grant.createdAt === "number" ? grant.createdAt : 0,
    lastUsedAt: typeof grant.lastUsedAt === "number" ? grant.lastUsedAt : null,
    accounts,
  };
}

/**
 * The grant after a use, or `null` when nothing worth a write changed: a
 * site reading its key on every render must not write storage every time.
 */
function touchedGrant(
  grant: OriginGrant,
  at: number,
  exposure?: { chainId: string; address: string },
): OriginGrant | null {
  const exposed =
    exposure !== undefined &&
    grantAllowsChain(grant, exposure.chainId) &&
    grant.accounts[exposure.chainId] !== exposure.address;
  const stale = grant.lastUsedAt === null || at - grant.lastUsedAt >= TOUCH_INTERVAL_MS;
  if (!exposed && !stale) return null;
  return {
    ...grant,
    lastUsedAt: at,
    accounts: exposed ? { ...grant.accounts, [exposure.chainId]: exposure.address } : grant.accounts,
  };
}

/** A stored permission value, or a storage change's old or new value, as grants. */
export function permissionStoreFrom(stored: unknown): PermissionStore {
  const store: PermissionStore = {};
  if (!stored || typeof stored !== "object") return store;
  for (const [origin, raw] of Object.entries(stored)) {
    const grant = normalizeGrant(origin, raw);
    if (grant) store[origin] = grant;
  }
  return store;
}

export async function loadPermissions(): Promise<PermissionStore> {
  const result = await browser.storage.local.get(STORAGE_KEYS.permissions);
  return permissionStoreFrom(result[STORAGE_KEYS.permissions]);
}

/** The chains a site may use right now, without touching the grant. */
export async function connectedChains(origin: string): Promise<string[]> {
  const grant = (await loadPermissions())[origin];
  return grant && isGrantActive(grant) ? [...grant.chainIds] : [];
}

async function savePermissions(store: PermissionStore): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEYS.permissions]: store });
}

let pendingWrite: Promise<unknown> = Promise.resolve();

/**
 * Run read-modify-write updates one after another. A site that reads keys
 * for several chains at once would otherwise lose all but one of them.
 */
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = pendingWrite.then(task, task);
  pendingWrite = run.catch(() => undefined);
  return run;
}

export function listActiveGrants(): Promise<OriginGrant[]> {
  return serialized(async () => {
    const store = await loadPermissions();
    const active: OriginGrant[] = [];
    let mutated = false;
    for (const [origin, grant] of Object.entries(store)) {
      if (!isGrantActive(grant)) {
        delete store[origin];
        mutated = true;
        continue;
      }
      active.push(grant);
    }
    if (mutated) await savePermissions(store);
    return active.sort((a, b) => a.origin.localeCompare(b.origin));
  });
}

export async function hasPermission(
  origin: string,
  chainIds: string[],
): Promise<boolean> {
  const store = await loadPermissions();
  const grant = store[origin];
  if (!grant || !isGrantActive(grant)) return false;
  return chainIds.every((id) => grantAllowsChain(grant, id));
}

export function grantPermission(
  origin: string,
  chainIds: string[],
  ttlMs: number | null = SECURITY_CONFIG.permissions.defaultTtlMs,
): Promise<OriginGrant> {
  return serialized(async () => {
    const store = await loadPermissions();
    const existing = store[origin];
    const kept = existing && isGrantActive(existing) ? existing : undefined;
    const at = now();
    const grant: OriginGrant = {
      origin,
      chainIds: [...new Set([...(kept?.chainIds ?? []), ...chainIds])],
      createdAt: existing?.createdAt ?? at,
      expiresAt: ttlMs == null ? null : at + ttlMs,
      lastUsedAt: at,
      accounts: kept?.accounts ?? {},
    };
    store[origin] = grant;
    await savePermissions(store);
    return grant;
  });
}

/**
 * Note that a site used its grant, and which address it was handed. Writes
 * at most once a minute unless the address is new.
 */
export function touchPermission(
  origin: string,
  exposure?: { chainId: string; address: string },
): Promise<void> {
  return serialized(async () => {
    const store = await loadPermissions();
    const grant = store[origin];
    if (!grant || !isGrantActive(grant)) return;
    const next = touchedGrant(grant, now(), exposure);
    if (!next) return;
    store[origin] = next;
    await savePermissions(store);
  });
}

export function revokePermission(origin: string): Promise<void> {
  return serialized(async () => {
    const store = await loadPermissions();
    if (!(origin in store)) return;
    delete store[origin];
    await savePermissions(store);
  });
}

export function revokeChain(origin: string, chainId: string): Promise<void> {
  return serialized(async () => {
    const store = await loadPermissions();
    const grant = store[origin];
    if (!grant) return;
    const chainIds = grant.chainIds.filter((id) => id !== chainId);
    if (chainIds.length === 0) {
      delete store[origin];
    } else {
      const { [chainId]: _dropped, ...accounts } = grant.accounts;
      store[origin] = { ...grant, chainIds, accounts };
    }
    await savePermissions(store);
  });
}

/** Forget every site. Returns the origins that still had a live grant. */
export function revokeAllPermissions(): Promise<string[]> {
  return serialized(async () => {
    const store = await loadPermissions();
    const origins = Object.values(store)
      .filter((grant) => isGrantActive(grant))
      .map((grant) => grant.origin);
    await savePermissions({});
    return origins;
  });
}

/** Pure helpers exported for unit tests (no browser APIs). */
export const permissionLogic = {
  isGrantActive,
  grantAllowsChain,
  normalizeGrant,
  touchedGrant,
  mergeChains(existing: string[], next: string[]): string[] {
    return [...new Set([...existing, ...next])];
  },
};
