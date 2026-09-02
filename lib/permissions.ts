import { SECURITY_CONFIG } from "../config/security";
import { STORAGE_KEYS } from "./storage-keys";

export interface OriginGrant {
  origin: string;
  chainIds: string[];
  /** Epoch ms; null means no expiry. */
  expiresAt: number | null;
  createdAt: number;
}

export type PermissionStore = Record<string, OriginGrant>;

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

export async function loadPermissions(): Promise<PermissionStore> {
  const result = await browser.storage.local.get(STORAGE_KEYS.permissions);
  return (result[STORAGE_KEYS.permissions] as PermissionStore | undefined) ?? {};
}

async function savePermissions(store: PermissionStore): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEYS.permissions]: store });
}

export async function listActiveGrants(): Promise<OriginGrant[]> {
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

export async function grantPermission(
  origin: string,
  chainIds: string[],
  ttlMs: number | null = SECURITY_CONFIG.permissions.defaultTtlMs,
): Promise<OriginGrant> {
  const store = await loadPermissions();
  const existing = store[origin];
  const merged = new Set<string>([
    ...(existing && isGrantActive(existing) ? existing.chainIds : []),
    ...chainIds,
  ]);
  const grant: OriginGrant = {
    origin,
    chainIds: [...merged],
    createdAt: existing?.createdAt ?? now(),
    expiresAt: ttlMs == null ? null : now() + ttlMs,
  };
  store[origin] = grant;
  await savePermissions(store);
  return grant;
}

export async function revokePermission(origin: string): Promise<void> {
  const store = await loadPermissions();
  delete store[origin];
  await savePermissions(store);
}

export async function revokeChain(
  origin: string,
  chainId: string,
): Promise<void> {
  const store = await loadPermissions();
  const grant = store[origin];
  if (!grant) return;
  grant.chainIds = grant.chainIds.filter((id) => id !== chainId);
  if (grant.chainIds.length === 0) delete store[origin];
  else store[origin] = grant;
  await savePermissions(store);
}

/** Pure helpers exported for unit tests (no browser APIs). */
export const permissionLogic = {
  isGrantActive,
  grantAllowsChain,
  mergeChains(existing: string[], next: string[]): string[] {
    return [...new Set([...existing, ...next])];
  },
};
