/**
 * The worker's push channel to the wallet's own surfaces.
 *
 * Everything the popup shows used to be pulled: it asked for balances once on
 * mount and again when the user hit refresh, so a transfer that arrived while
 * the popup was open stayed invisible until something re-asked. This is the
 * other direction. The worker watches the chains (`lib/realtime.ts`), and
 * whatever it learns is pushed down this port to every open surface.
 *
 * A port rather than `runtime.sendMessage`: a broadcast message has no delivery
 * guarantee and, in Chromium, logs an unhandled rejection whenever no surface
 * is open - which is most of the time for a wallet. A port also gives the
 * worker the one fact it genuinely needs, which is whether anyone is watching.
 *
 * Two rules keep this honest:
 *
 * 1. **The last snapshot is replayed on connect.** A popup is destroyed every
 *    time it loses focus, so "you already got that event" is never true of a
 *    freshly opened one. Without the replay the popup would render empty and
 *    then fill in, which is the flicker this channel exists to remove.
 * 2. **Nothing secret crosses it.** Balances, transaction hashes and notice
 *    text only. The same rule as every other message in this wallet.
 */

import type { ChainBalance } from "./balances";
import type { StreamState } from "./chain-stream";
import type { Notice } from "./notices";
import type { TxNotice } from "./realtime-protocol";

export const WALLET_EVENT_PORT = "zunia:wallet-events";

/** Per-chain health, so a surface can say "live" or "reconnecting" honestly. */
export type RealtimeHealth = Record<string, StreamState>;

export type WalletEvent =
  /** Fresh balances for the chains named. Partial: only what changed. */
  | { readonly type: "balances"; readonly balances: readonly ChainBalance[] }
  /** A transaction touching one of this wallet's addresses was included. */
  | { readonly type: "tx"; readonly notice: TxNotice }
  /** The derived notification feed, recomputed in the worker. */
  | {
      readonly type: "notices";
      readonly notices: readonly Notice[];
      readonly unread: number;
    }
  /** Which chains are live on a socket and which fell back to polling. */
  | { readonly type: "realtime"; readonly health: RealtimeHealth };

/**
 * What a newly connected surface is caught up with.
 *
 * Only the two events that describe *state* are replayed. A `tx` is an
 * announcement of something that happened at a moment, and replaying it to a
 * popup opened ten minutes later would re-animate a stale arrival.
 */
export interface WalletEventSnapshot {
  balances: readonly ChainBalance[];
  notices: readonly Notice[];
  unread: number;
  health: RealtimeHealth;
}

/* -------------------------------------------------------------------------- *
 * Worker side
 * -------------------------------------------------------------------------- */

type Port = ReturnType<typeof browser.runtime.connect>;

const ports = new Set<Port>();

const snapshot: WalletEventSnapshot = {
  balances: [],
  notices: [],
  unread: 0,
  health: {},
};

/**
 * What the worker last pushed.
 *
 * The realtime engine reads this back rather than threading balances through
 * every call site: a notification feed derived when only approvals changed
 * still needs the balances to keep its reward rows, and the snapshot is already
 * the one place that knows them.
 */
export function walletEventSnapshot(): WalletEventSnapshot {
  return {
    balances: snapshot.balances,
    notices: snapshot.notices,
    unread: snapshot.unread,
    health: snapshot.health,
  };
}

function post(port: Port, event: WalletEvent): void {
  try {
    port.postMessage(event);
  } catch {
    // The surface went away between the check and the send.
    ports.delete(port);
  }
}

/**
 * Record the event in the snapshot and hand it to every open surface.
 *
 * The snapshot is updated even with nothing connected, so the first popup
 * opened after an arrival still renders the new balance immediately rather
 * than waiting out a fetch.
 */
export function broadcastWalletEvent(event: WalletEvent): void {
  switch (event.type) {
    case "balances": {
      // Merge rather than replace: a single-chain update must not blank the
      // other chains' rows in a surface that is showing all of them.
      const byChain = new Map(snapshot.balances.map((row) => [row.chainId, row]));
      for (const row of event.balances) byChain.set(row.chainId, row);
      snapshot.balances = [...byChain.values()];
      break;
    }
    case "notices":
      snapshot.notices = event.notices;
      snapshot.unread = event.unread;
      break;
    case "realtime":
      snapshot.health = event.health;
      break;
    case "tx":
      break;
  }
  for (const port of ports) post(port, event);
}

/** Drop everything remembered. Called on lock and on account switch. */
export function resetWalletEventSnapshot(): void {
  snapshot.balances = [];
  snapshot.notices = [];
  snapshot.unread = 0;
  snapshot.health = {};
}

/**
 * Accept a surface's port. Called from the worker's `onConnect`.
 *
 * `onOpen` and `onClose` let the caller start and stop the realtime engine with
 * the surfaces that need it, without this module knowing what realtime is.
 */
export function registerWalletEventPort(
  port: Port,
  hooks: { onOpen?: () => void; onClose?: () => void } = {},
): void {
  ports.add(port);
  port.onDisconnect.addListener(() => {
    ports.delete(port);
    hooks.onClose?.();
  });
  post(port, { type: "balances", balances: snapshot.balances });
  post(port, {
    type: "notices",
    notices: snapshot.notices,
    unread: snapshot.unread,
  });
  post(port, { type: "realtime", health: snapshot.health });
  hooks.onOpen?.();
}

/* -------------------------------------------------------------------------- *
 * Surface side
 * -------------------------------------------------------------------------- */

/**
 * Listen for worker events from a popup, side panel or full-tab page.
 *
 * The port is reopened when the worker is torn down, which MV3 does whenever it
 * decides the worker has been idle. Without the retry the popup would go quiet
 * for the rest of its life the first time that happened, which is the failure
 * that makes a push channel feel less reliable than polling when it is not.
 */
export function subscribeWalletEvents(
  onEvent: (event: WalletEvent) => void,
): () => void {
  let stopped = false;
  let port: Port | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const open = (): void => {
    if (stopped) return;
    try {
      port = browser.runtime.connect({ name: WALLET_EVENT_PORT });
    } catch {
      retry = setTimeout(open, 1_000);
      return;
    }
    port.onMessage.addListener((message: unknown) => {
      if (stopped) return;
      const event = message as WalletEvent | null;
      if (event && typeof event.type === "string") onEvent(event);
    });
    port.onDisconnect.addListener(() => {
      port = null;
      if (!stopped) retry = setTimeout(open, 1_000);
    });
  };

  open();

  return () => {
    stopped = true;
    if (retry !== null) clearTimeout(retry);
    try {
      port?.disconnect();
    } catch {
      // Already gone.
    }
  };
}
