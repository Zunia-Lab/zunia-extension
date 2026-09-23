/**
 * Following signed routes after the popup closes.
 *
 * The popup tracks a route while it is open. This carries on from the
 * background worker on an alarm, so a route that settles while the popup is
 * closed still ends with one browser notification and, when nothing is left to
 * claim, drops out of the pending list. Every read is a public query, so it
 * keeps working while the wallet is locked.
 */

import { showBrowserAlert } from "./browser-alerts";
import { findCatalogEntry } from "./chain-catalog";
import { trackTransfer, type TrackedRoute } from "./packet-tracking";
import {
  listPendingTransfers,
  removePendingTransfer,
  type PendingTransfer,
} from "./pending-transfers";
import { STORAGE_KEYS } from "./storage-keys";

export const TRANSFER_WATCH_ALARM = "zunia.transferWatch";

/** Alarms below a minute are clamped or refused by some browsers. */
const WATCH_PERIOD_MINUTES = 1;
/** One walk may read several chains; past this the next alarm tries again. */
const POLL_TIMEOUT_MS = 45_000;
const MAX_NOTIFIED = 20;

export type RouteOutcome = "delivered" | "refunded" | "recoverable";

/**
 * What a settled route means for the funds, or `null` while it can still move.
 *
 * A timeout and an error acknowledgement both release the escrow back to the
 * sender. A swap whose output could not be delivered is different: the
 * contract holds it until the recovery address claims it.
 */
export function routeOutcome(route: TrackedRoute): RouteOutcome | null {
  if (!route.settled) return null;
  if (route.failure === "swap-delivery-failed") return "recoverable";
  if (route.failure === null && route.status === "acknowledged") return "delivered";
  return "refunded";
}

function chainName(chainId: string): string {
  return findCatalogEntry(chainId)?.chainName ?? chainId;
}

/** Title and body for the one notification a route ends with. */
export function outcomeAlert(
  record: Pick<PendingTransfer, "kind" | "label" | "chainId" | "plan">,
  route: Pick<TrackedRoute, "failure">,
  outcome: RouteOutcome,
): { title: string; message: string } {
  const noun = record.kind === "swap" ? "Swap" : "Transfer";
  const source = chainName(record.chainId);
  switch (outcome) {
    case "delivered":
      return record.kind === "swap"
        ? {
            title: "Swap complete",
            message: `${record.label} arrived on ${chainName(record.plan.destChainId)}.`,
          }
        : { title: "Transfer arrived", message: `${record.label} arrived.` };
    case "recoverable":
      return {
        title: "Swap needs your action",
        message: `The swap ran but could not deliver ${record.label}. Open Zunia to recover the tokens on Osmosis.`,
      };
    case "refunded":
      return route.failure === "timeout"
        ? {
            title: `${noun} timed out`,
            message: `${record.label} expired before delivery. The tokens go back to your account on ${source}.`,
          }
        : {
            title: `${noun} did not go through`,
            message: `${record.label} was refused on the way. The tokens go back to your account on ${source}.`,
          };
  }
}

async function readNotified(): Promise<string[]> {
  const stored = (await browser.storage.local.get(STORAGE_KEYS.notifiedTransfers))[
    STORAGE_KEYS.notifiedTransfers
  ];
  return Array.isArray(stored) ? stored.filter((row): row is string => typeof row === "string") : [];
}

async function markNotified(txHash: string): Promise<void> {
  const rows = await readNotified();
  if (rows.includes(txHash)) return;
  await browser.storage.local.set({
    [STORAGE_KEYS.notifiedTransfers]: [txHash, ...rows].slice(0, MAX_NOTIFIED),
  });
}

/** Pending routes that have not ended in a notification yet. */
async function watchable(): Promise<PendingTransfer[]> {
  const [pending, notified] = await Promise.all([listPendingTransfers(), readNotified()]);
  const done = new Set(notified);
  return pending.filter((row) => !done.has(row.txHash));
}

/** Keep the alarm alive exactly while some route is still being watched. */
export async function syncTransferWatch(): Promise<void> {
  const pending = await watchable();
  if (pending.length === 0) {
    await browser.alarms.clear(TRANSFER_WATCH_ALARM);
    return;
  }
  const existing = await browser.alarms.get(TRANSFER_WATCH_ALARM);
  if (existing) return;
  await browser.alarms.create(TRANSFER_WATCH_ALARM, {
    delayInMinutes: WATCH_PERIOD_MINUTES,
    periodInMinutes: WATCH_PERIOD_MINUTES,
  });
}

let running: Promise<void> | null = null;

/** One pass over every pending route. Overlapping alarms share the same pass. */
export function runTransferWatch(): Promise<void> {
  running ??= pollPending().finally(() => {
    running = null;
  });
  return running;
}

async function pollPending(): Promise<void> {
  for (const record of await watchable()) {
    let route: TrackedRoute;
    try {
      route = await trackTransfer({
        plan: record.plan,
        sourceTxHash: record.txHash,
        expectedAmount: record.amountBaseUnits,
        ...(record.swapContract ? { swapContract: record.swapContract } : {}),
        ...(record.recoveryAddress ? { recoveryAddress: record.recoveryAddress } : {}),
        signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
      });
    } catch {
      // Reads off, an endpoint down, or the walk ran long: the next alarm retries.
      continue;
    }
    const outcome = routeOutcome(route);
    if (!outcome) continue;
    const alert = outcomeAlert(record, route, outcome);
    await showBrowserAlert(`zunia-route-${record.txHash}`, alert.title, alert.message);
    await markNotified(record.txHash);
    // A recoverable swap stays listed: it is the way back to the recover action.
    if (outcome !== "recoverable") await removePendingTransfer(record.txHash);
  }
  await syncTransferWatch();
}
