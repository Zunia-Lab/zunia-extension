/**
 * In-flight routes, remembered across popup closes.
 *
 * A popup is destroyed the moment it loses focus, and a cross-chain route takes
 * a minute or several. Without this, closing the popup loses the only place the
 * wallet reports where the funds are — and, for a swap whose delivery failed,
 * the only place the `{"recover":{}}` action is reachable from. The record is
 * exactly what `trackRoute` needs and nothing else: no key material, no
 * balances, and it is dropped once the route settles without leaving anything
 * to claim.
 */

import type { RoutePlan } from "@zunialab/interchain";

import { STORAGE_KEYS } from "./storage-keys";

/** One signed route the wallet is still following. */
export interface PendingTransfer {
  readonly kind: "swap" | "transfer";
  /** The transaction the user signed. Unique per record. */
  readonly txHash: string;
  /** Chain it was signed on. */
  readonly chainId: string;
  /** The plan it executes; `trackRoute` walks this. */
  readonly plan: RoutePlan;
  /** Base units moved, so a batched relayer transaction can be told apart. */
  readonly amountBaseUnits: string;
  /** Crosschain-swaps contract, for the recovery message. Swaps only. */
  readonly swapContract?: string;
  /** The `local_recovery_addr` the swap declared. Swaps only. */
  readonly recoveryAddress?: string;
  /** Display label, e.g. `"1.5 ATOM → OSMO"`. */
  readonly label: string;
  readonly startedAt: number;
}

/** Keep the list short: this is a resume aid, not a transaction history. */
const MAX_RECORDS = 5;

/**
 * Records older than this are dropped on read.
 *
 * A day is far longer than any IBC timeout in this wallet (10 minutes per hop),
 * so anything still here has either settled unnoticed or is stuck, and in both
 * cases the source chain has long since refunded or the contract is holding it
 * for the recovery address, which is a claim the user makes deliberately.
 */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function isPending(value: unknown): value is PendingTransfer {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  const plan = row.plan as { hops?: unknown } | undefined;
  return (
    typeof row.txHash === "string" &&
    row.txHash.length > 0 &&
    typeof row.chainId === "string" &&
    typeof row.amountBaseUnits === "string" &&
    typeof plan === "object" &&
    plan !== null &&
    Array.isArray(plan.hops)
  );
}

/** Everything still being followed, newest first. Unreadable rows are dropped. */
export async function listPendingTransfers(): Promise<PendingTransfer[]> {
  const stored = (await browser.storage.local.get(STORAGE_KEYS.pendingTransfers))[
    STORAGE_KEYS.pendingTransfers
  ];
  if (!Array.isArray(stored)) return [];
  const cutoff = Date.now() - MAX_AGE_MS;
  return stored
    .filter(isPending)
    .filter((row) => row.startedAt > cutoff)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, MAX_RECORDS);
}

/** Remember a route that was just broadcast. Replaces any record with the same hash. */
export async function savePendingTransfer(record: PendingTransfer): Promise<void> {
  const existing = await listPendingTransfers();
  const next = [record, ...existing.filter((row) => row.txHash !== record.txHash)].slice(
    0,
    MAX_RECORDS,
  );
  await browser.storage.local.set({ [STORAGE_KEYS.pendingTransfers]: next });
}

/** Forget a route. Called when it lands, or when it fails with nothing to claim. */
export async function removePendingTransfer(txHash: string): Promise<void> {
  const existing = await listPendingTransfers();
  await browser.storage.local.set({
    [STORAGE_KEYS.pendingTransfers]: existing.filter((row) => row.txHash !== txHash),
  });
}
