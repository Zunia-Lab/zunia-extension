import { useCallback, useEffect, useState } from "react";
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

/**
 * Enabled chains for the wallet plus the active account's address on each,
 * derived in the background worker so the phrase stays there.
 */
export function useChainAccounts(unlocked: boolean, activeAccountIndex: number) {
  const [chainIds, setChainIds] = useState<string[]>([]);
  const [accounts, setAccounts] = useState<ChainAccountView[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      // Manually added chains are not in the bundled catalog, so pull them into
      // this context before resolving entries.
      await hydrateCustomChains().catch(() => []);
      const ids = await sendToBackground<string[]>("GET_ENABLED_CHAINS");
      setChainIds(ids);
      if (!unlocked) {
        setAccounts([]);
        return;
      }
      const derived = await sendToBackground<ChainAccount[]>(
        "GET_CHAIN_ACCOUNTS",
        { chainIds: ids },
      );
      setAccounts(
        derived.flatMap((account) => {
          const entry = findCatalogEntry(account.chainId);
          if (!entry) return [];
          return [
            {
              chainId: account.chainId,
              address: account.address,
              entry,
              iconUrl: catalogIconFor(entry),
            },
          ];
        }),
      );
    } finally {
      setLoading(false);
    }
  }, [unlocked]);

  useEffect(() => {
    void reload();
  }, [reload, activeAccountIndex]);

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

  return { chainIds, accounts, loading, reload };
}
