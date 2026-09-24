import type { OriginGrant, PermissionStore } from "./permissions";

/**
 * Wallet events a connected site hears, and who hears them.
 *
 * Every event is addressed to one origin and delivered only to tabs whose page
 * made provider calls from that origin, so a site never learns which other
 * sites the user connected, and a site that never connected hears nothing.
 */

export type ProviderEventName = "accountsChanged" | "chainChanged" | "disconnect" | "locked";

export interface OriginEvent {
  origin: string;
  event: ProviderEventName;
  /** chainChanged: every chain the site may use now. disconnect: the chains it lost, or null for all. */
  data: { chainIds: string[] } | null;
}

const EVENT_NAMES: ReadonlySet<string> = new Set<ProviderEventName>([
  "accountsChanged",
  "chainChanged",
  "disconnect",
  "locked",
]);

/** More chains than any site is granted; a cap on what crosses into the page. */
const MAX_EVENT_CHAINS = 256;

function chainsOf(grant: OriginGrant | undefined): string[] {
  return grant ? [...new Set(grant.chainIds)].sort() : [];
}

/**
 * What each site hears after the permission store went from `before` to
 * `after`. Only chain lists count: usage bookkeeping (last use, the addresses
 * handed out) rewrites the store without changing what a site may do.
 * Expired grants stay in the store until the expiry sweep deletes them, and
 * that deletion is what tells the site.
 */
export function grantChangeEvents(before: PermissionStore, after: PermissionStore): OriginEvent[] {
  const events: OriginEvent[] = [];
  const origins = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const origin of origins) {
    const was = chainsOf(before[origin]);
    const now = chainsOf(after[origin]);
    if (was.length === now.length && was.every((id, i) => id === now[i])) continue;
    if (now.length === 0) {
      events.push({ origin, event: "disconnect", data: null });
      continue;
    }
    const lost = was.filter((id) => !now.includes(id));
    if (lost.length > 0) events.push({ origin, event: "disconnect", data: { chainIds: lost } });
    events.push({ origin, event: "chainChanged", data: { chainIds: now } });
  }
  return events;
}

/** When the next grant runs out, or null when none will. */
export function nextGrantExpiry(store: PermissionStore): number | null {
  let next: number | null = null;
  for (const grant of Object.values(store)) {
    if (grant.expiresAt != null && (next === null || grant.expiresAt < next)) next = grant.expiresAt;
  }
  return next;
}

export interface PageEvent {
  event: ProviderEventName;
  data: { chainIds: string[] } | null;
}

/**
 * The event a content script passes to its page, or null when the message is
 * not addressed to this page's origin. A message without an origin is for
 * nobody.
 */
export function pageEventFor(payload: unknown, pageOrigin: string): PageEvent | null {
  const { event, origin, data } = (payload ?? {}) as {
    event?: unknown;
    origin?: unknown;
    data?: unknown;
  };
  if (origin !== pageOrigin || typeof event !== "string" || !EVENT_NAMES.has(event)) return null;
  const name = event as ProviderEventName;
  const named = (data as { chainIds?: unknown } | null | undefined)?.chainIds;
  const chainIds = Array.isArray(named)
    ? named.filter((id): id is string => typeof id === "string").slice(0, MAX_EVENT_CHAINS)
    : [];
  if (name === "chainChanged") return { event: name, data: { chainIds } };
  if (name === "disconnect") return { event: name, data: chainIds.length > 0 ? { chainIds } : null };
  return { event: name, data: null };
}
