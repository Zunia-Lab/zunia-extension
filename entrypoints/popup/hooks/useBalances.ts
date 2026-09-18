import { useCallback, useEffect, useState } from "react";
import type { ChainBalance } from "../../../lib/balances";
import { sendToBackground } from "../../../lib/popup-client";

/** Stable identity for the "nothing to show" map. */
const NO_BALANCES: Record<string, ChainBalance> = {};

/**
 * Live balances for the enabled chains. Returns an empty map when the user has
 * not opted in, which keeps every caller on the em-dash placeholder path.
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
        // Keep the last good map — a timed-out multi-chain refresh must not
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

  // Derived, not stored: turning live reads off empties the map on the same
  // render as the switch, with no effect writing {} and forcing a second pass.
  const balances = enabled ? (settled?.balances ?? NO_BALANCES) : NO_BALANCES;
  const loading =
    active &&
    (settled === null || settled.key !== key || settled.attempt !== attempt.n);

  const reload = useCallback((force = false) => {
    setAttempt((prev) => ({ n: prev.n + 1, force }));
  }, []);

  return { balances, loading, reload };
}
