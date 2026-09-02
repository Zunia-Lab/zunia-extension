import { useCallback, useEffect, useState } from "react";
import type { ChainBalance } from "../../../lib/balances";
import { sendToBackground } from "../../../lib/popup-client";

/**
 * Live balances for the enabled chains. Returns an empty map when the user has
 * not opted in, which keeps every caller on the em-dash placeholder path.
 */
export function useBalances(chainIds: string[], enabled: boolean) {
  const [balances, setBalances] = useState<Record<string, ChainBalance>>({});
  const [loading, setLoading] = useState(false);
  const key = chainIds.join(",");

  const reload = useCallback(
    async (force = false) => {
      if (!enabled || chainIds.length === 0) {
        setBalances({});
        return;
      }
      setLoading(true);
      try {
        const rows = await sendToBackground<ChainBalance[]>("GET_BALANCES", {
          chainIds,
          force,
        });
        setBalances(Object.fromEntries(rows.map((r) => [r.chainId, r])));
      } catch {
        setBalances({});
      } finally {
        setLoading(false);
      }
    },
    // chainIds is rebuilt on every render upstream; key keeps this stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [enabled, key],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  return { balances, loading, reload };
}
