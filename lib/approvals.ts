import { SECURITY_CONFIG } from "../config/security";
import { ProviderError, type ProviderErrorCode } from "./provider-errors";

export type ApprovalKind =
  | "enable"
  | "signAmino"
  | "signDirect"
  | "signArbitrary"
  | "sendTx"
  | "suggestChain";

/** Kinds that produce a signature, and so may require the password. */
export const SIGNING_KINDS: ReadonlySet<ApprovalKind> = new Set([
  "signAmino",
  "signDirect",
  "signArbitrary",
]);

/** Where the request is being shown. Decides which closed surface rejects it. */
export type ApprovalHost = "overlay" | "popup";

export interface ApprovalRequest {
  id: string;
  kind: ApprovalKind;
  origin: string;
  chainIds: string[];
  createdAt: number;
  /** Rejected automatically at this time if nobody answers. */
  expiresAt: number;
  /** Human-readable summary for the popup. */
  title: string;
  detail?: Record<string, unknown>;
  warnings?: string[];
  /** Tab the dApp request came from. Closing it rejects the request. */
  tabId?: number;
  host?: ApprovalHost;
}

type Resolver = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

const queue: ApprovalRequest[] = [];
const resolvers = new Map<string, Resolver>();
const results = new Map<string, Promise<unknown>>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<(pending: ApprovalRequest[]) => void>();

function notify(): void {
  const snapshot = [...queue];
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch (err) {
      console.error("[zunia] approvals listener failed", err);
    }
  }
}

/** Called with the queue after every change. Returns an unsubscribe function. */
export function onApprovalsChanged(
  listener: (pending: ApprovalRequest[]) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getPendingApprovals(): ApprovalRequest[] {
  return [...queue];
}

export function getApproval(id: string): ApprovalRequest | undefined {
  return queue.find((item) => item.id === id);
}

export function pendingCount(): number {
  return queue.length;
}

export interface EnqueuedApproval {
  id: string;
  /** Settles when the request is approved, rejected, expired, or cancelled. */
  result: Promise<unknown>;
}

function settle(id: string, outcome: { value?: unknown; error?: Error }): boolean {
  const idx = queue.findIndex((item) => item.id === id);
  if (idx < 0) return false;
  queue.splice(idx, 1);
  const resolver = resolvers.get(id);
  resolvers.delete(id);
  results.delete(id);
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  if (outcome.error) resolver?.reject(outcome.error);
  else resolver?.resolve(outcome.value);
  notify();
  return true;
}

/**
 * Same as {@link enqueueApproval} but hands back the id, so a caller can point
 * a specific surface (the in-page connect modal) at this exact request instead
 * of guessing which queue entry is theirs. Throws synchronously when the queue
 * is full.
 */
export function enqueueApprovalWithId(
  request: Omit<ApprovalRequest, "id" | "createdAt" | "expiresAt">,
): EnqueuedApproval {
  if (queue.length >= SECURITY_CONFIG.rateLimits.maxPendingApprovals) {
    throw new Error(
      `Too many pending approvals (max ${SECURITY_CONFIG.rateLimits.maxPendingApprovals})`,
    );
  }

  const id = crypto.randomUUID();
  const createdAt = Date.now();
  const full: ApprovalRequest = {
    ...request,
    id,
    createdAt,
    expiresAt: createdAt + SECURITY_CONFIG.approvals.ttlMs,
  };

  const result = new Promise<unknown>((resolve, reject) => {
    queue.push(full);
    resolvers.set(id, { resolve, reject });
  });
  results.set(id, result);
  timers.set(
    id,
    setTimeout(
      () =>
        settle(id, {
          error: new ProviderError("USER_REJECTED", "Request expired before it was answered"),
        }),
      SECURITY_CONFIG.approvals.ttlMs,
    ),
  );
  notify();

  return { id, result };
}

export function enqueueApproval(
  request: Omit<ApprovalRequest, "id" | "createdAt" | "expiresAt">,
): Promise<unknown> {
  try {
    return enqueueApprovalWithId(request).result;
  } catch (err) {
    return Promise.reject(err);
  }
}

/**
 * A pending connection request from the same origin in the same tab, if any.
 * dApps often call `enable` for several chains at once; those calls share one
 * prompt instead of stacking up and filling the queue.
 */
export function findPendingEnable(
  origin: string,
  tabId: number | undefined,
): EnqueuedApproval | null {
  const match = queue.find(
    (item) => item.kind === "enable" && item.origin === origin && item.tabId === tabId,
  );
  const result = match ? results.get(match.id) : undefined;
  return match && result ? { id: match.id, result } : null;
}

/** Add chains to a pending connection request. The user sees the merged list. */
export function extendApprovalChains(id: string, chainIds: string[]): void {
  const item = queue.find((entry) => entry.id === id);
  if (!item) return;
  const merged = [...new Set([...item.chainIds, ...chainIds])];
  if (merged.length === item.chainIds.length) return;
  item.chainIds = merged;
  item.detail = { ...item.detail, chainIds: merged };
  notify();
}

export function setApprovalHost(id: string, host: ApprovalHost): void {
  const item = queue.find((entry) => entry.id === id);
  if (!item || item.host === host) return;
  item.host = host;
  notify();
}

export function resolveApproval(id: string, result: unknown): boolean {
  return settle(id, { value: result });
}

/** The page reads the reason, so it keeps Keplr's wording by default. */
export function rejectApproval(
  id: string,
  reason = "Request rejected",
  code: ProviderErrorCode = "USER_REJECTED",
): boolean {
  return settle(id, { error: new ProviderError(code, reason) });
}

/** Reject every pending request the predicate selects. Returns how many were rejected. */
export function rejectApprovalsWhere(
  predicate: (item: ApprovalRequest) => boolean,
  reason: string,
  code: ProviderErrorCode = "USER_REJECTED",
): number {
  const ids = queue.filter(predicate).map((item) => item.id);
  for (const id of ids) settle(id, { error: new ProviderError(code, reason) });
  return ids.length;
}

export function clearApprovals(reason = "Wallet locked"): void {
  rejectApprovalsWhere(() => true, reason, "LOCKED");
}

/** Test-only reset. */
export function resetApprovalsForTests(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  queue.length = 0;
  resolvers.clear();
  results.clear();
  timers.clear();
  listeners.clear();
}
