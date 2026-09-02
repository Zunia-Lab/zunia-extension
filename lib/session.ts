import { SESSION_CONFIG } from "../config/session";
import { STORAGE_KEYS } from "./storage-keys";
import { chainJsonFor } from "./chains";
import { loadKernel } from "./kernel";
import { clearApprovals } from "./approvals";

export interface AccountInfo {
  index: number;
  name: string;
  address: string;
  algo: string;
  /** Hex-encoded compressed pubkey when available. */
  pubKeyHex?: string;
}

export interface WalletMeta {
  createdAt: number;
  wordCount: 12 | 24;
}

export interface SessionStatus {
  hasWallet: boolean;
  unlocked: boolean;
  accounts: AccountInfo[];
  activeAccountIndex: number;
  autoLockMs: number;
}

interface EnvelopeRecord {
  envelope: string;
  meta: WalletMeta;
}

function clampLockMs(ms: number): number {
  return Math.min(
    SESSION_CONFIG.autoLock.maxMs,
    Math.max(SESSION_CONFIG.autoLock.minMs, ms),
  );
}

export async function getAutoLockMs(): Promise<number> {
  const result = await browser.storage.local.get(STORAGE_KEYS.settings);
  const settings = result[STORAGE_KEYS.settings] as
    | { autoLockMs?: number }
    | undefined;
  return clampLockMs(settings?.autoLockMs ?? SESSION_CONFIG.autoLock.defaultMs);
}

export async function hasEnvelope(): Promise<boolean> {
  const result = await browser.storage.local.get(STORAGE_KEYS.envelope);
  return Boolean(result[STORAGE_KEYS.envelope]);
}

export async function getAccounts(): Promise<AccountInfo[]> {
  const result = await browser.storage.local.get(STORAGE_KEYS.accounts);
  return (result[STORAGE_KEYS.accounts] as AccountInfo[] | undefined) ?? [];
}

export async function getActiveAccountIndex(): Promise<number> {
  const session = await browser.storage.session.get(
    STORAGE_KEYS.sessionActiveAccount,
  );
  if (typeof session[STORAGE_KEYS.sessionActiveAccount] === "number") {
    return session[STORAGE_KEYS.sessionActiveAccount] as number;
  }
  return 0;
}

export async function isUnlocked(): Promise<boolean> {
  const session = await browser.storage.session.get(STORAGE_KEYS.sessionMnemonic);
  return typeof session[STORAGE_KEYS.sessionMnemonic] === "string";
}

export async function getSessionMnemonic(): Promise<string | null> {
  const session = await browser.storage.session.get(STORAGE_KEYS.sessionMnemonic);
  const mnemonic = session[STORAGE_KEYS.sessionMnemonic];
  return typeof mnemonic === "string" ? mnemonic : null;
}

async function persistAccounts(accounts: AccountInfo[]): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEYS.accounts]: accounts });
}

async function deriveDefaultAccount(
  phrase: string,
  index: number,
  name: string,
): Promise<AccountInfo> {
  const kernel = await loadKernel();
  const derived = kernel.deriveAddress(
    phrase,
    "",
    JSON.stringify({ bech32Prefix: "cosmos", chainId: "cosmoshub-4" }),
    index,
  );
  return {
    index,
    name,
    address: derived.bech32Address,
    algo: derived.algo,
    pubKeyHex: Array.from(derived.pubKey, (b) =>
      b.toString(16).padStart(2, "0"),
    ).join(""),
  };
}

export async function scheduleAutoLock(): Promise<void> {
  const ms = await getAutoLockMs();
  const delayInMinutes = Math.max(1, Math.ceil(ms / 60_000));
  await browser.alarms.clear(SESSION_CONFIG.autoLock.alarmName);
  await browser.alarms.create(SESSION_CONFIG.autoLock.alarmName, {
    delayInMinutes,
  });
}

export async function touchSession(): Promise<void> {
  if (!(await isUnlocked())) return;
  await browser.storage.session.set({
    [STORAGE_KEYS.sessionUnlockedAt]: Date.now(),
  });
  await scheduleAutoLock();
}

export async function lockWallet(): Promise<void> {
  await browser.storage.session.remove([
    STORAGE_KEYS.sessionMnemonic,
    STORAGE_KEYS.sessionUnlockedAt,
    STORAGE_KEYS.sessionActiveAccount,
  ]);
  await browser.alarms.clear(SESSION_CONFIG.autoLock.alarmName);
  clearApprovals("Wallet locked");
}

async function unlockWithMnemonic(
  phrase: string,
  activeIndex = 0,
): Promise<void> {
  // NEVER write mnemonic to chrome.storage.local.
  await browser.storage.session.set({
    [STORAGE_KEYS.sessionMnemonic]: phrase,
    [STORAGE_KEYS.sessionUnlockedAt]: Date.now(),
    [STORAGE_KEYS.sessionActiveAccount]: activeIndex,
  });
  await scheduleAutoLock();
}

export async function generateMnemonicPhrase(
  wordCount: 12 | 24 = 12,
): Promise<string> {
  const kernel = await loadKernel();
  const mnemonic = kernel.generateMnemonic(wordCount);
  if (!kernel.validateMnemonic(mnemonic)) {
    throw new Error("Generated mnemonic failed validation");
  }
  return mnemonic;
}

export async function createWallet(input: {
  password: string;
  wordCount?: 12 | 24;
  /** When set, seal this phrase instead of generating a new one. */
  mnemonic?: string;
  name?: string;
  enabledChainIds?: string[];
}): Promise<{ mnemonic: string; account: AccountInfo }> {
  if (await hasEnvelope()) {
    throw new Error("Wallet already exists");
  }
  const kernel = await loadKernel();
  let mnemonic = input.mnemonic?.trim().replace(/\s+/g, " ");
  const wordCount = (input.wordCount ??
    (mnemonic?.split(" ").length === 24 ? 24 : 12)) as 12 | 24;
  if (!mnemonic) {
    mnemonic = kernel.generateMnemonic(wordCount);
  }
  if (!kernel.validateMnemonic(mnemonic)) {
    throw new Error("Generated mnemonic failed validation");
  }
  const meta: WalletMeta = { createdAt: Date.now(), wordCount };
  const envelope = kernel.sealKeyring(
    mnemonic,
    input.password,
    JSON.stringify(meta),
  );
  const account = await deriveDefaultAccount(
    mnemonic,
    0,
    cleanName(input.name, "Account 1"),
  );
  await browser.storage.local.set({
    [STORAGE_KEYS.envelope]: { envelope, meta } satisfies EnvelopeRecord,
  });
  if (input.enabledChainIds && input.enabledChainIds.length > 0) {
    await browser.storage.local.set({
      [STORAGE_KEYS.enabledChains]: [...new Set(input.enabledChainIds)],
    });
  }
  await persistAccounts([account]);
  await unlockWithMnemonic(mnemonic, 0);
  return { mnemonic, account };
}

export async function importWallet(input: {
  mnemonic: string;
  password: string;
  name?: string;
  enabledChainIds?: string[];
}): Promise<AccountInfo> {
  if (await hasEnvelope()) {
    throw new Error("Wallet already exists");
  }
  const kernel = await loadKernel();
  const phrase = input.mnemonic.trim().replace(/\s+/g, " ");
  if (!kernel.validateMnemonic(phrase)) {
    throw new Error("Invalid recovery phrase");
  }
  const parts = phrase.split(" ");
  const wordCount = (parts.length === 24 ? 24 : 12) as 12 | 24;
  const meta: WalletMeta = { createdAt: Date.now(), wordCount };
  const envelope = kernel.sealKeyring(
    phrase,
    input.password,
    JSON.stringify(meta),
  );
  const account = await deriveDefaultAccount(
    phrase,
    0,
    cleanName(input.name, "Account 1"),
  );
  await browser.storage.local.set({
    [STORAGE_KEYS.envelope]: { envelope, meta } satisfies EnvelopeRecord,
  });
  if (input.enabledChainIds && input.enabledChainIds.length > 0) {
    await browser.storage.local.set({
      [STORAGE_KEYS.enabledChains]: [...new Set(input.enabledChainIds)],
    });
  }
  await persistAccounts([account]);
  await unlockWithMnemonic(phrase, 0);
  return account;
}

export async function unlockWallet(password: string): Promise<AccountInfo[]> {
  const result = await browser.storage.local.get(STORAGE_KEYS.envelope);
  const record = result[STORAGE_KEYS.envelope] as EnvelopeRecord | undefined;
  if (!record?.envelope) {
    throw new Error("No wallet found");
  }
  const kernel = await loadKernel();
  const phrase = kernel.openKeyring(record.envelope, password);
  let accounts = await getAccounts();
  if (accounts.length === 0) {
    accounts = [await deriveDefaultAccount(phrase, 0, "Account 1")];
    await persistAccounts(accounts);
  }
  await unlockWithMnemonic(phrase, 0);
  return accounts;
}

export interface ChainAccount {
  chainId: string;
  address: string;
}

/**
 * Bech32 address of the active account on each requested chain.
 * Requires an unlocked session — the phrase never leaves the worker.
 */
export async function getChainAccounts(
  chainIds: string[],
): Promise<ChainAccount[]> {
  const phrase = await getSessionMnemonic();
  if (!phrase) throw new Error("Wallet is locked");
  const kernel = await loadKernel();
  const index = await getActiveAccountIndex();
  return chainIds.map((chainId) => ({
    chainId,
    address: kernel.deriveAddress(phrase, "", chainJsonFor(chainId), index)
      .bech32Address,
  }));
}

/** Re-open the sealed envelope. Always gated by the password prompt. */
export async function revealMnemonic(password: string): Promise<string> {
  const result = await browser.storage.local.get(STORAGE_KEYS.envelope);
  const record = result[STORAGE_KEYS.envelope] as EnvelopeRecord | undefined;
  if (!record?.envelope) throw new Error("No wallet found");
  const kernel = await loadKernel();
  return kernel.openKeyring(record.envelope, password);
}

/**
 * Wipe every wallet artefact from this browser profile.
 * The password is optional: a forgotten password still has to be recoverable
 * by wiping local state and restoring from the phrase.
 */
export async function resetWallet(password?: string): Promise<void> {
  if (password) await revealMnemonic(password);
  await lockWallet();
  await browser.storage.local.remove([
    STORAGE_KEYS.envelope,
    STORAGE_KEYS.accounts,
    STORAGE_KEYS.permissions,
    STORAGE_KEYS.knownRecipients,
    STORAGE_KEYS.suggestedChains,
    STORAGE_KEYS.enabledChains,
    STORAGE_KEYS.balanceCache,
    STORAGE_KEYS.addressBook,
  ]);
}

function cleanName(name: string | undefined, fallback: string): string {
  const trimmed = (name ?? "").trim().replace(/\s+/g, " ");
  return trimmed.length > 0 ? trimmed.slice(0, 32) : fallback;
}

/** Derive the next BIP-44 account index off the same phrase. */
export async function addAccount(name?: string): Promise<AccountInfo> {
  const phrase = await getSessionMnemonic();
  if (!phrase) throw new Error("Wallet is locked");
  const accounts = await getAccounts();
  const index = accounts.reduce((max, a) => Math.max(max, a.index), -1) + 1;
  const account = await deriveDefaultAccount(
    phrase,
    index,
    cleanName(name, `Account ${index + 1}`),
  );
  await persistAccounts([...accounts, account]);
  return account;
}

export async function renameAccount(
  index: number,
  name: string,
): Promise<AccountInfo[]> {
  const accounts = await getAccounts();
  const target = accounts.find((a) => a.index === index);
  if (!target) throw new Error("Unknown account");
  const next = accounts.map((a) =>
    a.index === index
      ? { ...a, name: cleanName(name, `Account ${index + 1}`) }
      : a,
  );
  await persistAccounts(next);
  return next;
}

export async function setActiveAccount(index: number): Promise<void> {
  const accounts = await getAccounts();
  if (!accounts.some((a) => a.index === index)) {
    throw new Error("Unknown account");
  }
  await browser.storage.session.set({
    [STORAGE_KEYS.sessionActiveAccount]: index,
  });
  await touchSession();
}

export async function getStatus(): Promise<SessionStatus> {
  const accounts = await getAccounts();
  return {
    hasWallet: await hasEnvelope(),
    unlocked: await isUnlocked(),
    accounts,
    activeAccountIndex: await getActiveAccountIndex(),
    autoLockMs: await getAutoLockMs(),
  };
}

export function registerSessionLifecycle(): void {
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SESSION_CONFIG.autoLock.alarmName) {
      void lockWallet();
    }
  });

  // Chromium service worker suspend — wipe session if configured.
  const runtime = browser.runtime as typeof browser.runtime & {
    onSuspend?: { addListener: (cb: () => void) => void };
  };
  if (SESSION_CONFIG.autoLock.onBrowserClose && runtime.onSuspend) {
    runtime.onSuspend.addListener(() => {
      void lockWallet();
    });
  }

  if (SESSION_CONFIG.autoLock.onDeviceLock && browser.idle?.onStateChanged) {
    browser.idle.onStateChanged.addListener((state) => {
      if (state === "locked") void lockWallet();
    });
  }
}
