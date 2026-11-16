import { useCallback, useEffect, useRef, useState } from "react";

import type { ChainBalance } from "../../../lib/balances";
import { sendToBackground } from "../../../lib/popup-client";

/**
 * Reads named chains from the network now, past the worker's one-minute cache.
 *
 * `useBalances` owns what the screens show: the fetch it makes at start-up and
 * the rows the worker pushes. This is the other half, for a screen that knows
 * its numbers may be old (it just opened, or a transaction just landed) and
 * wants exactly those chains read again. It returns nothing to render: the
 * worker folds every answer into the same push, so `useBalances` shows it on
 * its own. What it does return is what the screen says about the read: that
 * one is running, and for which chains the last one failed.
 *
 * `refresh` resolves with the rows read, empty when reads are off or the
 * worker did not answer, and never rejects.
 */
export function useBalanceRefresh(enabled: boolean): {
  refresh: (chainIds: readonly string[]) => Promise<ChainBalance[]>;
  /** A read started by `refresh` has not answered yet. */
  refreshing: boolean;
  /** Chains whose last read gave no usable row, until a later read does. */
  failed: readonly string[];
} {
  const [running, setRunning] = useState(0);
  const [failed, setFailed] = useState<readonly string[]>([]);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(
    async (chainIds: readonly string[]): Promise<ChainBalance[]> => {
      if (!enabled || chainIds.length === 0) return [];
      setRunning((n) => n + 1);
      let rows: ChainBalance[] = [];
      try {
        rows = await sendToBackground<ChainBalance[]>("GET_BALANCES", {
          chainIds: [...chainIds],
          force: true,
        });
      } catch {
        // Reported through `failed`: every chain asked for gave nothing.
      }
      if (alive.current) {
        setRunning((n) => n - 1);
        setFailed((previous) => {
          const next = new Set(previous);
          for (const chainId of chainIds) {
            const row = rows.find((candidate) => candidate.chainId === chainId);
            if (row && !row.error) next.delete(chainId);
            else next.add(chainId);
          }
          return [...next];
        });
      }
      return rows;
    },
    [enabled],
  );

  return { refresh, refreshing: running > 0, failed };
}
