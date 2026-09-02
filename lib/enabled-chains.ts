import { PINNED_CHAIN_IDS, findCatalogEntry } from "./chain-catalog";
import { STORAGE_KEYS } from "./storage-keys";

/** Fallback when onboarding never wrote a selection. */
export const DEFAULT_ENABLED_CHAIN_IDS: string[] = [...PINNED_CHAIN_IDS];

export async function getEnabledChainIds(): Promise<string[]> {
  const result = await browser.storage.local.get(STORAGE_KEYS.enabledChains);
  const stored = result[STORAGE_KEYS.enabledChains] as string[] | undefined;
  const known = (stored ?? []).filter((id) => findCatalogEntry(id));
  return known.length > 0 ? known : DEFAULT_ENABLED_CHAIN_IDS;
}

export async function setEnabledChainIds(ids: string[]): Promise<string[]> {
  const next = [...new Set(ids)].filter((id) => findCatalogEntry(id));
  if (next.length === 0) {
    throw new Error("Keep at least one network enabled");
  }
  await browser.storage.local.set({ [STORAGE_KEYS.enabledChains]: next });
  return next;
}
