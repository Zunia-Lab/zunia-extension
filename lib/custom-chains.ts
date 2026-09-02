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
import { CHAIN_CATALOG } from "./chain-catalog.generated";
import { STORAGE_KEYS } from "./storage-keys";

export interface CustomChainDraft {
  chainName: string;
  chainId: string;
  rpc: string;
  rest: string;
  bech32Prefix: string;
  coinType: number;
  coinDenom: string;
  coinMinimalDenom: string;
  coinDecimals: number;
  gasPrice: number;
}

function isHttps(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

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

/** Pull saved chains into the in-memory catalog. Call once per context boot. */
export async function hydrateCustomChains(): Promise<CatalogEntry[]> {
  const rows = await read();
  setCustomCatalogEntries(rows);
  return rows;
}

export async function saveCustomChain(
  draft: CustomChainDraft,
): Promise<CatalogEntry[]> {
  const chainId = draft.chainId.trim();
  if (!chainId) throw new Error("Chain ID is required");
  if (CHAIN_CATALOG.some((c) => c.chainId === chainId)) {
    throw new Error("That chain ID is already in the registry");
  }
  if (!/^[a-z]{2,}$/.test(draft.bech32Prefix)) {
    throw new Error("Prefix must be lowercase letters");
  }
  if (!isHttps(draft.rpc) || !isHttps(draft.rest)) {
    throw new Error("RPC and REST must be https:// URLs");
  }
  if (!Number.isInteger(draft.coinType) || draft.coinType < 0) {
    throw new Error("Coin type must be a whole number");
  }

  const rows = await read();
  const next = [
    ...rows.filter((c) => c.chainId !== chainId),
    toEntry({ ...draft, chainId }),
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
