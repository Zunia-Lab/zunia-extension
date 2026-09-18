import { useCallback, useEffect, useState } from "react";
import type { PriceMap } from "../../../lib/prices";
import { sendToBackground } from "../../../lib/popup-client";

/** Stable identity for "no prices to show". */
const NO_PRICES: PriceMap = {};

/**
 * Spot prices for the enabled chains. Empty until the user opts into live
 * reads, and never covers chains the registry has no price id for.
 */
export function usePrices(chainIds: string[], enabled: boolean) {
  const key = chainIds.join(",");
  const active = enabled && chainIds.length > 0;
  // See useBalances: `force` belongs to the attempt, not to a call argument.
  const [attempt, setAttempt] = useState({ n: 0, force: false });
  const [settled, setSettled] = useState<{
    key: string;
    attempt: number;
    prices: PriceMap;
  } | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    sendToBackground<PriceMap>("GET_PRICES", { chainIds, force: attempt.force })
      .then((next) => {
        if (!cancelled) setSettled({ key, attempt: attempt.n, prices: next });
      })
      .catch(() => {
        // A failed price fetch shows em dashes rather than stale numbers next
        // to a balance that did refresh.
        if (!cancelled)
          setSettled({ key, attempt: attempt.n, prices: NO_PRICES });
      });
    return () => {
      cancelled = true;
    };
    // chainIds is rebuilt on every render upstream; key stands in for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key, attempt]);

  // Derived, not stored: no live reads (or no chains) means no prices on the
  // same render, instead of an effect writing {} a render later.
  const prices = active && settled?.key === key ? settled.prices : NO_PRICES;

  const reload = useCallback((force = false) => {
    setAttempt((prev) => ({ n: prev.n + 1, force }));
  }, []);

  return { prices, reload };
}
