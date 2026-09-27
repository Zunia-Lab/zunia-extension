import { PINNED_CHAIN_IDS, findCatalogEntry } from "./chain-catalog";
import { hydrateCustomChains } from "./custom-chains";
import { STORAGE_KEYS } from "./storage-keys";

/** Fallback when onboarding never wrote a selection. */
export const DEFAULT_ENABLED_CHAIN_IDS: string[] = [...PINNED_CHAIN_IDS];

interface AccountRow {
  index: number;
  enabledChainIds?: string[];
}

async function knownChainIds(ids: string[]): Promise<string[]> {
  // Custom chains live outside the bundled catalog; hydrate before filtering
  // or a saved custom id is dropped as "unknown".
  await hydrateCustomChains().catch(() => []);
  return [...new Set(ids)].filter((id) => findCatalogEntry(id));
}

async function readAccounts(): Promise<AccountRow[]> {
  const result = await browser.storage.local.get(STORAGE_KEYS.accounts);
  const rows = result[STORAGE_KEYS.accounts];
  return Array.isArray(rows) ? (rows as AccountRow[]) : [];
}

async function readActiveIndex(): Promise<number> {
  const session = await browser.storage.session.get(
    STORAGE_KEYS.sessionActiveAccount,
  );
  const value = session[STORAGE_KEYS.sessionActiveAccount];
  return typeof value === "number" ? value : 0;
}

async function globalFallback(): Promise<string[]> {
  const result = await browser.storage.local.get(STORAGE_KEYS.enabledChains);
  const stored = result[STORAGE_KEYS.enabledChains] as string[] | undefined;
  const known = await knownChainIds(stored ?? []);
  return known.length > 0 ? known : DEFAULT_ENABLED_CHAIN_IDS;
}

function accountAt(accounts: AccountRow[], index: number): AccountRow | undefined {
  return accounts.find((row) => row.index === index) ?? accounts[0];
}

/**
 * Copy a missing per-account list from the legacy global key so older
 * installs keep the networks they already picked, once per account.
 */
async function migrateAccount(
  accounts: AccountRow[],
  account: AccountRow,
  ids: string[],
): Promise<void> {
  const next = accounts.map((row) =>
    row.index === account.index ? { ...row, enabledChainIds: ids } : row,
  );
  await browser.storage.local.set({ [STORAGE_KEYS.accounts]: next });
}

export async function getEnabledChainIds(): Promise<string[]> {
  const [accounts, active] = await Promise.all([
    readAccounts(),
    readActiveIndex(),
  ]);
  const account = accountAt(accounts, active);
  if (account?.enabledChainIds && account.enabledChainIds.length > 0) {
    const known = await knownChainIds(account.enabledChainIds);
    if (known.length > 0) return known;
  }
  const fallback = await globalFallback();
  if (account) await migrateAccount(accounts, account, fallback);
  return fallback;
}

export async function setEnabledChainIds(ids: string[]): Promise<string[]> {
  const next = await knownChainIds(ids);
  if (next.length === 0) {
    throw new Error("Keep at least one network enabled");
  }
  const [accounts, active] = await Promise.all([
    readAccounts(),
    readActiveIndex(),
  ]);
  const account = accountAt(accounts, active);
  if (!account) {
    await browser.storage.local.set({ [STORAGE_KEYS.enabledChains]: next });
    return next;
  }
  const updated = accounts.map((row) =>
    row.index === account.index ? { ...row, enabledChainIds: next } : row,
  );
  await browser.storage.local.set({ [STORAGE_KEYS.accounts]: updated });
  return next;
}
