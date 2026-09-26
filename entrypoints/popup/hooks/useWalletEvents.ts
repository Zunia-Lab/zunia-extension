import { useSyncExternalStore } from "react";

import type { ChainBalance } from "../../../lib/balances";
import type { Notice } from "../../../lib/notices";
import type { TxNotice } from "../../../lib/realtime-protocol";
import {
  subscribeWalletEvents,
  type RealtimeHealth,
  type WalletEvent,
} from "../../../lib/wallet-events";

/**
 * What the worker is currently telling this surface.
 *
 * One store for the whole popup rather than a hook per consumer: the channel is
 * a single port, and a hook that opened its own would mean one port per mounted
 * screen, each replaying the same snapshot. `useSyncExternalStore` is what lets
 * several components read it without any of them owning it.
 */
export interface RealtimeSnapshot {
  /** Keyed by chain id, the same shape `useBalances` hands to the screens. */
  readonly balances: Readonly<Record<string, ChainBalance>>;
  readonly notices: readonly Notice[];
  readonly unread: number;
  readonly health: RealtimeHealth;
  /**
   * Bumped on every transaction the worker reports.
   *
   * A counter rather than the notice itself, because what a screen wants is
   * "something happened, re-read" and a dependency on the object identity would
   * also fire on an unrelated re-render. `lastTx` carries the detail for the
   * one place that animates an arrival.
   */
  readonly txSeq: number;
  readonly lastTx: TxNotice | null;
  /** False until the port has delivered its first message. */
  readonly connected: boolean;
}

const EMPTY: RealtimeSnapshot = {
  balances: {},
  notices: [],
  unread: 0,
  health: {},
  txSeq: 0,
  lastTx: null,
  connected: false,
};

let snapshot: RealtimeSnapshot = EMPTY;
const listeners = new Set<() => void>();
let unsubscribe: (() => void) | null = null;

function emit(next: RealtimeSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function apply(event: WalletEvent): void {
  switch (event.type) {
    case "balances": {
      // Merged, not replaced: the worker sends only the chains that changed.
      const balances = { ...snapshot.balances };
      for (const row of event.balances) balances[row.chainId] = row;
      emit({ ...snapshot, balances, connected: true });
      return;
    }
    case "notices":
      emit({
        ...snapshot,
        notices: event.notices,
        unread: event.unread,
        connected: true,
      });
      return;
    case "realtime":
      emit({ ...snapshot, health: event.health, connected: true });
      return;
    case "tx":
      emit({
        ...snapshot,
        txSeq: snapshot.txSeq + 1,
        lastTx: event.notice,
        connected: true,
      });
      return;
  }
}

/**
 * Open the port on the first listener and close it on the last.
 *
 * The popup is torn down whenever it loses focus, so an open port that nothing
 * is reading is a real cost rather than a theoretical one: it keeps the MV3
 * worker awake for a surface that no longer exists.
 */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) unsubscribe = subscribeWalletEvents(apply);
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    unsubscribe?.();
    unsubscribe = null;
    // Reset, so a surface opened later does not render one account's balances
    // for a moment before the new snapshot lands.
    snapshot = EMPTY;
  };
}

function getSnapshot(): RealtimeSnapshot {
  return snapshot;
}

/** Everything the worker has pushed. Re-renders only when something changed. */
export function useRealtime(): RealtimeSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Whether any chain is on a live socket.
 *
 * `false` is not an error state: a chain past the socket cap, or one whose node
 * refuses subscriptions, is polled every minute instead. The distinction is
 * worth showing because "updates the moment it lands" and "updates within a
 * minute" are different promises and the UI should only make the one it keeps.
 */
export function anyChainLive(health: RealtimeHealth): boolean {
  return Object.values(health).some((state) => state === "live");
}
