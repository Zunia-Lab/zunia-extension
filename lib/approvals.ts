import { SECURITY_CONFIG } from "../config/security";

export type ApprovalKind =
  | "enable"
  | "signAmino"
  | "signDirect"
  | "sendTx"
  | "suggestChain";

export interface ApprovalRequest {
  id: string;
  kind: ApprovalKind;
  origin: string;
  chainIds: string[];
  createdAt: number;
  /** Human-readable summary for the popup. */
  title: string;
  detail?: Record<string, unknown>;
  warnings?: string[];
}

type Resolver = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

const queue: ApprovalRequest[] = [];
const resolvers = new Map<string, Resolver>();

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
  /** Settles when the request is approved, rejected, or cancelled. */
  result: Promise<unknown>;
}

/**
 * Same as {@link enqueueApproval} but hands back the id, so a caller can point
 * a specific surface (the in-page connect modal) at this exact request instead
 * of guessing which queue entry is theirs. Throws synchronously when the queue
 * is full.
 */
export function enqueueApprovalWithId(
  request: Omit<ApprovalRequest, "id" | "createdAt">,
): EnqueuedApproval {
  if (queue.length >= SECURITY_CONFIG.rateLimits.maxPendingApprovals) {
    throw new Error(
      `Too many pending approvals (max ${SECURITY_CONFIG.rateLimits.maxPendingApprovals})`,
    );
  }

  const id = crypto.randomUUID();
  const full: ApprovalRequest = {
    ...request,
    id,
    createdAt: Date.now(),
  };

  const result = new Promise<unknown>((resolve, reject) => {
    queue.push(full);
    resolvers.set(id, { resolve, reject });
  });

  return { id, result };
}

export function enqueueApproval(
  request: Omit<ApprovalRequest, "id" | "createdAt">,
): Promise<unknown> {
  try {
    return enqueueApprovalWithId(request).result;
  } catch (err) {
    return Promise.reject(err);
  }
}

export function resolveApproval(id: string, result: unknown): boolean {
  const idx = queue.findIndex((item) => item.id === id);
  if (idx < 0) return false;
  queue.splice(idx, 1);
  const resolver = resolvers.get(id);
  resolvers.delete(id);
  resolver?.resolve(result);
  return true;
}

export function rejectApproval(id: string, reason = "User rejected"): boolean {
  const idx = queue.findIndex((item) => item.id === id);
  if (idx < 0) return false;
  queue.splice(idx, 1);
  const resolver = resolvers.get(id);
  resolvers.delete(id);
  resolver?.reject(new Error(reason));
  return true;
}

export function clearApprovals(reason = "Wallet locked"): void {
  while (queue.length) {
    const item = queue.pop()!;
    const resolver = resolvers.get(item.id);
    resolvers.delete(item.id);
    resolver?.reject(new Error(reason));
  }
}

/** Test-only reset. */
export function resetApprovalsForTests(): void {
  queue.length = 0;
  resolvers.clear();
}
