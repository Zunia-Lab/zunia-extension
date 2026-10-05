/**
 * Chains the user typed in by hand, for networks the bundled registry does not
 * carry. They live next to the registry rows in every picker and derive
 * addresses the same way, but they are never trusted for anything else.
 */

import {
  findCatalogEntry,
  setCustomCatalogEntries,
  type CatalogEntry,
} from "./chain-catalog";
import { validateCustomChainDraft, type CustomChainDraft } from "./chain-draft";
import { STORAGE_KEYS } from "./storage-keys";
import { hydrateTokenIdentities } from "./token-identity";

export type { CustomChainDraft } from "./chain-draft";

function toEntry(draft: CustomChainDraft): CatalogEntry {
  return {
    chainId: draft.chainId,
    chainName: draft.chainName,
    bech32Prefix: draft.bech32Prefix,
    coinType: draft.coinType,
    network: "testnet",
    coinDenom: draft.coinDenom,
    coinMinimalDenom: draft.coinMinimalDenom,
    coinDecimals: draft.coinDecimals,
    feeDenom: draft.coinDenom,
    feeMinimalDenom: draft.coinMinimalDenom,
    feeDecimals: draft.coinDecimals,
    gasPriceStep: {
      low: draft.gasPrice,
      average: draft.gasPrice,
      high: draft.gasPrice * 2,
    },
    rpc: draft.rpc,
    rest: draft.rest,
    inCosmosRegistry: false,
  };
}

async function read(): Promise<CatalogEntry[]> {
  const store = await browser.storage.local.get(STORAGE_KEYS.customChains);
  const rows = store[STORAGE_KEYS.customChains];
  return Array.isArray(rows) ? (rows as CatalogEntry[]) : [];
}

export async function listCustomChains(): Promise<CatalogEntry[]> {
  return read();
}

/**
 * Pull saved chains into the in-memory catalog. Call once per context boot.
 *
 * Also loads the token-identity facts cache, because every context that names
 * a chain also names its tokens: this is the one boot hook the background,
 * the popup and the approval window all run.
 */
export async function hydrateCustomChains(): Promise<CatalogEntry[]> {
  const rows = await read();
  setCustomCatalogEntries(rows);
  await hydrateTokenIdentities();
  return rows;
}

export async function saveCustomChain(
  draft: CustomChainDraft,
): Promise<CatalogEntry[]> {
  const clean = validateCustomChainDraft(draft);
  const rows = await read();
  const next = [
    ...rows.filter((c) => c.chainId !== clean.chainId),
    toEntry(clean),
  ];
  await browser.storage.local.set({ [STORAGE_KEYS.customChains]: next });
  setCustomCatalogEntries(next);
  return next;
}

export async function removeCustomChain(
  chainId: string,
): Promise<CatalogEntry[]> {
  const rows = await read();
  const next = rows.filter((c) => c.chainId !== chainId);
  await browser.storage.local.set({ [STORAGE_KEYS.customChains]: next });
  setCustomCatalogEntries(next);
  return next;
}

export function chainIdTaken(chainId: string): boolean {
  return Boolean(findCatalogEntry(chainId.trim()));
}
