import { useCallback, useEffect, useRef, useState } from "react";
import {
  catalogIconFor,
  findCatalogEntry,
  type CatalogEntry,
} from "../../../lib/chain-catalog";
import { hydrateCustomChains } from "../../../lib/custom-chains";
import type { ChainAccount } from "../../../lib/session";
import { STORAGE_KEYS } from "../../../lib/storage-keys";
import { sendToBackground } from "../../../lib/popup-client";

export interface ChainAccountView {
  chainId: string;
  address: string;
  entry: CatalogEntry;
  iconUrl?: string;
}

/** Stable identities for "nothing loaded yet". */
const NO_CHAIN_IDS: string[] = [];
const NO_ACCOUNTS: ChainAccountView[] = [];

/**
 * Enabled chains for the wallet plus the active account's address on each,
 * derived in the background worker so the phrase stays there.
 */
export function useChainAccounts(unlocked: boolean, activeAccountIndex: number) {
  const [refreshToken, setRefreshToken] = useState(0);
  // Identity of the request the hook should currently be showing. `loading` is
  // derived from it, so unlocking or switching account reads as loading on the
  // very render that changes it — no effect flipping a flag, and no second
  // render pass per load.
  const requestKey = `${unlocked ? "unlocked" : "locked"}:${activeAccountIndex}:${refreshToken}`;
  const [settled, setSettled] = useState<{
    requestKey: string;
    chainIds: string[];
    accounts: ChainAccountView[];
  } | null>(null);
  // reload() resolves when the request it triggered has settled; App chains a
  // forced balance/price refresh onto it.
  const waiters = useRef<Array<() => void>>([]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        // Manually added chains are not in the bundled catalog, so pull them
        // into this context before resolving entries.
        await hydrateCustomChains().catch(() => []);
        const ids = await sendToBackground<string[]>("GET_ENABLED_CHAINS");
        if (cancelled) return;

        // Always surface every enabled catalog row on Home, even before (or
        // without) a successful address derive, so Manage Networks never looks
        // like a no-op.
        const viewsFor = (byId: Map<string, string>): ChainAccountView[] =>
          ids.flatMap((chainId) => {
            const entry = findCatalogEntry(chainId);
            if (!entry) return [];
            return [
              {
                chainId,
                address: byId.get(chainId) ?? "",
                entry,
                iconUrl: catalogIconFor(entry),
              },
            ];
          });

        if (!unlocked) {
          setSettled({
            requestKey,
            chainIds: ids,
            accounts: viewsFor(new Map()),
          });
          return;
        }

        let derived: ChainAccount[] = [];
        try {
          derived = await sendToBackground<ChainAccount[]>(
            "GET_CHAIN_ACCOUNTS",
            { chainIds: ids },
          );
        } catch {
          derived = [];
        }
        if (cancelled) return;

        setSettled({
          requestKey,
          chainIds: ids,
          accounts: viewsFor(
            new Map(derived.map((row) => [row.chainId, row.address])),
          ),
        });
      } catch {
        if (cancelled) return;
        // Keep the last good list; a transient failure after toggling networks
        // should not wipe the popup. Settle the request anyway so `loading`
        // clears instead of spinning forever.
        setSettled((prev) => ({
          requestKey,
          chainIds: prev?.chainIds ?? NO_CHAIN_IDS,
          accounts: prev?.accounts ?? NO_ACCOUNTS,
        }));
      } finally {
        // A cancelled run leaves the waiters for the run that superseded it.
        if (!cancelled) {
          for (const resolve of waiters.current.splice(0)) resolve();
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [requestKey, unlocked]);

  const reload = useCallback(
    () =>
      new Promise<void>((resolve) => {
        waiters.current.push(resolve);
        setRefreshToken((n) => n + 1);
      }),
    [],
  );

  // Networks / Add Chain write chrome.storage.local; keep every screen in sync
  // without waiting for a remount or account switch.
  useEffect(() => {
    const onChanged: Parameters<
      typeof browser.storage.onChanged.addListener
    >[0] = (changes, area) => {
      if (area !== "local") return;
      if (
        changes[STORAGE_KEYS.enabledChains] ||
        changes[STORAGE_KEYS.customChains]
      ) {
        void reload();
      }
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => browser.storage.onChanged.removeListener(onChanged);
  }, [reload]);

  return {
    chainIds: settled?.chainIds ?? NO_CHAIN_IDS,
    accounts: settled?.accounts ?? NO_ACCOUNTS,
    loading: settled?.requestKey !== requestKey,
    reload,
  };
}
