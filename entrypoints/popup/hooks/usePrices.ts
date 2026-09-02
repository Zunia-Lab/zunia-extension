import { useCallback, useEffect, useState } from "react";
import type { PriceMap } from "../../../lib/prices";
import { sendToBackground } from "../../../lib/popup-client";

/**
 * Spot prices for the enabled chains. Empty until the user opts into live
 * reads, and never covers chains the registry has no price id for.
 */
export function usePrices(chainIds: string[], enabled: boolean) {
  const [prices, setPrices] = useState<PriceMap>({});
  const key = chainIds.join(",");

  const reload = useCallback(
    async (force = false) => {
      if (!enabled || chainIds.length === 0) {
        setPrices({});
        return;
      }
      try {
        setPrices(await sendToBackground<PriceMap>("GET_PRICES", {
          chainIds,
          force,
        }));
      } catch {
        setPrices({});
      }
    },
    // chainIds is rebuilt on every render upstream; key keeps this stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [enabled, key],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  return { prices, reload };
}
