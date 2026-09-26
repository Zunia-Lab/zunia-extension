import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChainBalance } from "../../../lib/balances";
import { sendToBackground } from "../../../lib/popup-client";
import { useRealtime } from "./useWalletEvents";

/** Stable identity for the "nothing to show" map. */
const NO_BALANCES: Record<string, ChainBalance> = {};

/**
 * Live balances for the enabled chains.
 *
 * Two sources, in one order. The fetch is the cold start: a surface that has
 * just opened asks once, so it renders numbers even if no chain event happens
 * while it is on screen. The worker's push is everything after that - it
 * watches the chains on a socket and sends each chain's new balance the moment
 * it changes, so a transfer that lands with the popup open updates the row
 * without anything here asking again.
 *
 * The push always wins, because it cannot be older: the worker also folds the
 * answer to this hook's own fetch into the same channel, so the two agree by
 * construction rather than by racing.
 *
 * Returns an empty map when the user has not opted in, which keeps every caller
 * on the em-dash placeholder path.
 */
export function useBalances(chainIds: string[], enabled: boolean) {
  const key = chainIds.join(",");
  const active = enabled && chainIds.length > 0;
  // `force` rides on the attempt rather than on a call argument that is gone by
  // the time the request goes out: a manual refresh issued while the chain list
  // is still changing would otherwise settle against the old list and the real
  // fetch would go out unforced.
  const [attempt, setAttempt] = useState({ n: 0, force: false });
  const [settled, setSettled] = useState<{
    key: string;
    attempt: number;
    balances: Record<string, ChainBalance>;
  } | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    sendToBackground<ChainBalance[]>("GET_BALANCES", {
      chainIds,
      force: attempt.force,
    })
      .then((rows) => {
        if (cancelled) return;
        setSettled({
          key,
          attempt: attempt.n,
          balances: Object.fromEntries(rows.map((r) => [r.chainId, r])),
        });
      })
      .catch(() => {
        if (cancelled) return;
        // Keep the last good map: a timed-out multi-chain refresh must not
        // blank the home list to em dashes. Settle the attempt anyway so the
        // spinner stops instead of running forever.
        setSettled((prev) => ({
          key,
          attempt: attempt.n,
          balances: prev?.balances ?? NO_BALANCES,
        }));
      });
    return () => {
      cancelled = true;
    };
    // chainIds is rebuilt on every render upstream; key stands in for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key, attempt]);

  const pushed = useRealtime().balances;

  const balances = useMemo(() => {
    // Derived, not stored: turning live reads off empties the map on the same
    // render as the switch, with no effect writing {} and forcing a second pass.
    if (!enabled) return NO_BALANCES;
    const fetched = settled?.balances ?? NO_BALANCES;
    // Scoped to the chains this caller asked about. The worker's picture spans
    // every enabled chain, and a screen showing three of them must not suddenly
    // grow rows for the other twenty.
    const merged: Record<string, ChainBalance> = {};
    for (const chainId of chainIds) {
      const row = pushed[chainId] ?? fetched[chainId];
      if (row) merged[chainId] = row;
    }
    return Object.keys(merged).length > 0 ? merged : NO_BALANCES;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key, settled, pushed]);

  // Loading only until something has arrived. A push that beat the fetch is a
  // perfectly good first render, so the skeleton stops there rather than
  // waiting out a request whose answer is already on screen.
  const loading =
    active &&
    Object.keys(balances).length === 0 &&
    (settled === null || settled.key !== key || settled.attempt !== attempt.n);

  const reload = useCallback((force = false) => {
    setAttempt((prev) => ({ n: prev.n + 1, force }));
  }, []);

  return { balances, loading, reload };
}
