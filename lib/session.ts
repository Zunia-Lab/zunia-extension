import { SESSION_CONFIG } from "../config/session";
import { STORAGE_KEYS } from "./storage-keys";
import {
  avatarSeedOf,
  derivationIndexOf,
  pickAvatarSeed,
} from "./account-avatar";
import { chainJsonFor } from "./chains";
import { hydrateCustomChains } from "./custom-chains";
import { loadKernel } from "./kernel";
import { clearApprovals } from "./approvals";
import {
  EMPTY_THROTTLE,
  assertNotThrottled,
  readThrottleState,
  recordFailure,
  type ThrottleState,
} from "./password-throttle";

export interface AccountInfo {
  index: number;
  name: string;
  address: string;
  algo: string;
  /** Hex-encoded compressed pubkey when available. */
  pubKeyHex?: string;
  /**
   * This account has its own recovery phrase (not an HD child of the first).
   * New accounts are always this. Older extras stay HD off the first phrase.
   */
  ownSeed?: boolean;
  /** Stable seed for the 3D orb. Different accounts get different colours. */
  avatarSeed?: string;
  /** Networks this account shows. Independent of other accounts. */
  enabledChainIds?: string[];
}

export { avatarSeedOf, derivationIndexOf };

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

type PhraseMap = Record<string, string>;

export async function getSessionMnemonicMap(): Promise<PhraseMap> {
  const session = await browser.storage.session.get(STORAGE_KEYS.sessionMnemonics);
  const raw = session[STORAGE_KEYS.sessionMnemonics];
  if (raw && typeof raw === "object") return raw as PhraseMap;
  const single = await getSessionMnemonic();
  return single ? { primary: single, "0": single } : {};
}

async function getSessionPassword(): Promise<string | null> {
  const session = await browser.storage.session.get(STORAGE_KEYS.sessionPassword);
  const password = session[STORAGE_KEYS.sessionPassword];
  return typeof password === "string" && password.length > 0 ? password : null;
}

function phraseFor(account: AccountInfo, map: PhraseMap): string | null {
  if (account.ownSeed) {
    return map[String(account.index)] ?? map.primary ?? null;
  }
  return map.primary ?? map["0"] ?? null;
}

export async function getActiveDerivationIndex(): Promise<number> {
  const accounts = await getAccounts();
  const active = await getActiveAccountIndex();
  const account = accounts.find((row) => row.index === active) ?? accounts[0];
  return account ? derivationIndexOf(account) : 0;
}

type ExtraEnvelopeMap = Record<string, EnvelopeRecord>;

async function getExtraEnvelopes(): Promise<ExtraEnvelopeMap> {
  const result = await browser.storage.local.get(STORAGE_KEYS.accountEnvelopes);
  const raw = result[STORAGE_KEYS.accountEnvelopes];
  return raw && typeof raw === "object" ? (raw as ExtraEnvelopeMap) : {};
}

async function persistExtraEnvelopes(map: ExtraEnvelopeMap): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEYS.accountEnvelopes]: map });
}

async function persistAccounts(accounts: AccountInfo[]): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEYS.accounts]: accounts });
}

async function deriveDefaultAccount(
  phrase: string,
  index: number,
  name: string,
  extras?: {
    ownSeed?: boolean;
    avatarSeed?: string;
    enabledChainIds?: string[];
  },
): Promise<AccountInfo> {
  const kernel = await loadKernel();
  const derived = kernel.deriveAddress(
    phrase,
    "",
    JSON.stringify({ bech32Prefix: "cosmos", chainId: "cosmoshub-4" }),
    extras?.ownSeed ? 0 : index,
  );
  return {
    index,
    name,
    address: derived.bech32Address,
    algo: derived.algo,
    pubKeyHex: Array.from(derived.pubKey, (b) =>
      b.toString(16).padStart(2, "0"),
    ).join(""),
    ...(extras?.ownSeed ? { ownSeed: true } : {}),
    ...(extras?.avatarSeed ? { avatarSeed: extras.avatarSeed } : {}),
    ...(extras?.enabledChainIds && extras.enabledChainIds.length > 0
      ? { enabledChainIds: [...new Set(extras.enabledChainIds)] }
      : {}),
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
    STORAGE_KEYS.sessionMnemonics,
    STORAGE_KEYS.sessionPassword,
    STORAGE_KEYS.sessionUnlockedAt,
    STORAGE_KEYS.sessionActiveAccount,
  ]);
  await browser.alarms.clear(SESSION_CONFIG.autoLock.alarmName);
  clearApprovals("Wallet locked");
}

async function unlockWithMnemonic(
  phrase: string,
  activeIndex = 0,
  extras?: { map?: PhraseMap; password?: string },
): Promise<void> {
  // NEVER write mnemonic or password to chrome.storage.local.
  const map: PhraseMap = extras?.map ?? { primary: phrase, "0": phrase };
  const next: Record<string, unknown> = {
    [STORAGE_KEYS.sessionMnemonic]: phrase,
    [STORAGE_KEYS.sessionMnemonics]: map,
    [STORAGE_KEYS.sessionUnlockedAt]: Date.now(),
    [STORAGE_KEYS.sessionActiveAccount]: activeIndex,
  };
  if (extras?.password) next[STORAGE_KEYS.sessionPassword] = extras.password;
  await browser.storage.session.set(next);
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
  const enabledChainIds =
    input.enabledChainIds && input.enabledChainIds.length > 0
      ? [...new Set(input.enabledChainIds)]
      : undefined;
  const account = await deriveDefaultAccount(
    mnemonic,
    0,
    cleanName(input.name, "Account 1"),
    {
      ownSeed: true,
      avatarSeed: pickAvatarSeed([]),
      ...(enabledChainIds ? { enabledChainIds } : {}),
    },
  );
  await browser.storage.local.set({
    [STORAGE_KEYS.envelope]: { envelope, meta } satisfies EnvelopeRecord,
  });
  if (enabledChainIds) {
    await browser.storage.local.set({
      [STORAGE_KEYS.enabledChains]: enabledChainIds,
    });
  }
  await persistAccounts([account]);
  await unlockWithMnemonic(mnemonic, 0, {
    map: { primary: mnemonic, "0": mnemonic },
    password: input.password,
  });
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
  const enabledChainIds =
    input.enabledChainIds && input.enabledChainIds.length > 0
      ? [...new Set(input.enabledChainIds)]
      : undefined;
  const account = await deriveDefaultAccount(
    phrase,
    0,
    cleanName(input.name, "Account 1"),
    {
      ownSeed: true,
      avatarSeed: pickAvatarSeed([]),
      ...(enabledChainIds ? { enabledChainIds } : {}),
    },
  );
  await browser.storage.local.set({
    [STORAGE_KEYS.envelope]: { envelope, meta } satisfies EnvelopeRecord,
  });
  if (enabledChainIds) {
    await browser.storage.local.set({
      [STORAGE_KEYS.enabledChains]: enabledChainIds,
    });
  }
  await persistAccounts([account]);
  await unlockWithMnemonic(phrase, 0, {
    map: { primary: phrase, "0": phrase },
    password: input.password,
  });
  return account;
}

export async function getPasswordThrottle(): Promise<ThrottleState> {
  const result = await browser.storage.local.get(STORAGE_KEYS.passwordThrottle);
  return readThrottleState(result[STORAGE_KEYS.passwordThrottle], Date.now());
}

let passwordQueue: Promise<unknown> = Promise.resolve();

/** One password check at a time, so parallel guesses cannot all read a clean throttle. */
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = passwordQueue.then(task, task);
  passwordQueue = run.catch(() => undefined);
  return run;
}

/**
 * Open the sealed envelope with the password, refusing while a backoff is in
 * force and extending it on every failure. Every password check goes through here.
 */
function openEnvelope(password: string): Promise<string> {
  return serialized(() => openEnvelopeNow(password));
}

async function firstSealedEnvelope(): Promise<string> {
  const result = await browser.storage.local.get(STORAGE_KEYS.envelope);
  const record = result[STORAGE_KEYS.envelope] as EnvelopeRecord | undefined;
  if (record?.envelope) return record.envelope;
  const extras = await getExtraEnvelopes();
  const first = Object.values(extras)[0];
  if (first?.envelope) return first.envelope;
  throw new Error("No wallet found");
}

async function openEnvelopeNow(password: string): Promise<string> {
  const sealed = await firstSealedEnvelope();

  const throttle = await getPasswordThrottle();
  assertNotThrottled(throttle, Date.now());

  const kernel = await loadKernel();
  let phrase: string;
  try {
    phrase = kernel.openKeyring(sealed, password);
  } catch {
    const next = recordFailure(throttle, Date.now());
    await browser.storage.local.set({ [STORAGE_KEYS.passwordThrottle]: next });
    throw new Error(
      next.retryAt
        ? `Wrong password. Wait ${Math.ceil((next.retryAt - Date.now()) / 1000)} s before trying again.`
        : "Wrong password",
    );
  }
  if (throttle.failures > 0) {
    await browser.storage.local.set({ [STORAGE_KEYS.passwordThrottle]: EMPTY_THROTTLE });
  }
  return phrase;
}

/** Check the password without changing the session. Used for per-signature confirmation. */
export async function verifyPassword(password: string): Promise<void> {
  if (typeof password !== "string" || !password) {
    throw new Error("Enter your password to sign");
  }
  await openEnvelope(password);
}

export async function unlockWallet(password: string): Promise<AccountInfo[]> {
  const primary = await openEnvelope(password);
  const kernel = await loadKernel();
  const extras = await getExtraEnvelopes();
  const map: PhraseMap = { primary, "0": primary };
  for (const [key, record] of Object.entries(extras)) {
    try {
      map[key] = kernel.openKeyring(record.envelope, password);
    } catch {
      throw new Error("Wrong password");
    }
  }

  let accounts = await getAccounts();
  if (accounts.length === 0) {
    accounts = [
      await deriveDefaultAccount(primary, 0, "Account 1", {
        ownSeed: true,
        avatarSeed: pickAvatarSeed([]),
      }),
    ];
    await persistAccounts(accounts);
  } else {
    accounts = await ensureAvatarSeeds(accounts);
  }

  const active = accounts.some((row) => row.index === 0) ? 0 : (accounts[0]?.index ?? 0);
  const activeAccount = accounts.find((row) => row.index === active) ?? accounts[0]!;
  const activePhrase = phraseFor(activeAccount, map) ?? primary;
  await unlockWithMnemonic(activePhrase, active, { map, password });
  return accounts;
}

async function ensureAvatarSeeds(accounts: AccountInfo[]): Promise<AccountInfo[]> {
  if (accounts.every((row) => row.avatarSeed)) return accounts;
  const taken: string[] = [];
  const next = accounts.map((row) => {
    if (row.avatarSeed) {
      taken.push(row.avatarSeed);
      return row;
    }
    const seed = pickAvatarSeed(taken);
    taken.push(seed);
    return { ...row, avatarSeed: seed };
  });
  await persistAccounts(next);
  return next;
}

export interface ChainAccount {
  chainId: string;
  address: string;
}

/**
 * Bech32 address of the active account on each requested chain.
 * Requires an unlocked session; the phrase never leaves the worker.
 */
export async function getChainAccounts(
  chainIds: string[],
): Promise<ChainAccount[]> {
  const phrase = await getSessionMnemonic();
  if (!phrase) throw new Error("Wallet is locked");
  await hydrateCustomChains().catch(() => []);
  const kernel = await loadKernel();
  const index = await getActiveDerivationIndex();
  // Skip chains that cannot derive (bad catalog row, unsupported scheme) so
  // one broken network does not blank the whole home list after Manage Networks.
  const out: ChainAccount[] = [];
  for (const chainId of chainIds) {
    try {
      out.push({
        chainId,
        address: kernel.deriveAddress(
          phrase,
          "",
          chainJsonFor(chainId),
          index,
        ).bech32Address,
      });
    } catch (err) {
      console.warn(`[zunia] skip derive for ${chainId}`, err);
    }
  }
  return out;
}

/** Re-open the sealed envelope of the active account. Always gated by the password. */
export async function revealMnemonic(password: string): Promise<string> {
  await openEnvelope(password);
  const accounts = await getAccounts();
  const active = await getActiveAccountIndex();
  const account = accounts.find((row) => row.index === active) ?? accounts[0];
  if (!account) throw new Error("No account");
  if (account.ownSeed && account.index !== 0) {
    const extras = await getExtraEnvelopes();
    const record = extras[String(account.index)];
    if (!record?.envelope) throw new Error("This account has no recovery phrase stored");
    const kernel = await loadKernel();
    return kernel.openKeyring(record.envelope, password);
  }
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
    STORAGE_KEYS.accountEnvelopes,
    STORAGE_KEYS.accounts,
    STORAGE_KEYS.permissions,
    STORAGE_KEYS.knownRecipients,
    STORAGE_KEYS.suggestedChains,
    STORAGE_KEYS.enabledChains,
    STORAGE_KEYS.balanceCache,
    STORAGE_KEYS.addressBook,
    STORAGE_KEYS.passwordThrottle,
    STORAGE_KEYS.pickerMemory,
    STORAGE_KEYS.pendingTransfers,
    STORAGE_KEYS.notifiedTransfers,
    STORAGE_KEYS.readNotifications,
  ]);
}

function cleanName(name: string | undefined, fallback: string): string {
  const trimmed = (name ?? "").trim().replace(/\s+/g, " ");
  return trimmed.length > 0 ? trimmed.slice(0, 32) : fallback;
}

/**
 * Add an independent account: its own recovery phrase, sealed with the
 * already-unlocked password. Not another HD child of the first wallet.
 */
export async function addAccountSeed(input: {
  mnemonic: string;
  name?: string;
  enabledChainIds?: string[];
}): Promise<AccountInfo> {
  if (!(await isUnlocked())) throw new Error("Wallet is locked");
  const password = await getSessionPassword();
  if (!password) {
    throw new Error("Unlock the wallet again, then add the account.");
  }
  const kernel = await loadKernel();
  const phrase = input.mnemonic.trim().replace(/\s+/g, " ");
  if (!kernel.validateMnemonic(phrase)) {
    throw new Error("Invalid recovery phrase");
  }
  const map = await getSessionMnemonicMap();
  if (Object.values(map).some((existing) => existing === phrase)) {
    throw new Error("This recovery phrase is already in this wallet.");
  }

  const accounts = await getAccounts();
  const index = accounts.reduce((max, row) => Math.max(max, row.index), -1) + 1;
  const wordCount = (phrase.split(" ").length === 24 ? 24 : 12) as 12 | 24;
  const meta: WalletMeta = { createdAt: Date.now(), wordCount };
  const envelope = kernel.sealKeyring(phrase, password, JSON.stringify(meta));
  const extras = await getExtraEnvelopes();
  extras[String(index)] = { envelope, meta };
  await persistExtraEnvelopes(extras);

  const enabledChainIds =
    input.enabledChainIds && input.enabledChainIds.length > 0
      ? [...new Set(input.enabledChainIds)]
      : undefined;
  const account = await deriveDefaultAccount(
    phrase,
    index,
    cleanName(input.name, `Account ${index + 1}`),
    {
      ownSeed: true,
      avatarSeed: pickAvatarSeed(accounts.map((row) => avatarSeedOf(row))),
      ...(enabledChainIds ? { enabledChainIds } : {}),
    },
  );
  await persistAccounts([...accounts, account]);
  map[String(index)] = phrase;
  await unlockWithMnemonic(phrase, index, { map, password });
  return account;
}

export async function removeAccount(index: number): Promise<AccountInfo[]> {
  const accounts = await getAccounts();
  if (accounts.length <= 1) {
    throw new Error("Keep at least one account. Reset the wallet to remove the last one.");
  }
  const target = accounts.find((row) => row.index === index);
  if (!target) throw new Error("Unknown account");

  const next = accounts.filter((row) => row.index !== index);
  await persistAccounts(next);

  if (target.ownSeed && target.index !== 0) {
    const extras = await getExtraEnvelopes();
    delete extras[String(index)];
    await persistExtraEnvelopes(extras);
  }
  const map = await getSessionMnemonicMap();
  delete map[String(index)];
  if (target.index === 0 && target.ownSeed) {
    const extras = await getExtraEnvelopes();
    const promoted = Object.entries(extras)[0];
    if (promoted) {
      await browser.storage.local.set({
        [STORAGE_KEYS.envelope]: promoted[1],
      });
      delete extras[promoted[0]];
      await persistExtraEnvelopes(extras);
      const promotedPhrase = map[promoted[0]];
      if (promotedPhrase) map.primary = promotedPhrase;
    }
  }
  const active = await getActiveAccountIndex();
  const fallback = next[0]!;
  const nextActive = next.some((row) => row.index === active) ? active : fallback.index;
  const nextAccount = next.find((row) => row.index === nextActive) ?? fallback;
  const phrase = phraseFor(nextAccount, map);
  if (!phrase) throw new Error("Wallet is locked");
  const password = await getSessionPassword();
  await unlockWithMnemonic(phrase, nextActive, {
    map,
    ...(password ? { password } : {}),
  });
  return next;
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
  const account = accounts.find((row) => row.index === index);
  if (!account) throw new Error("Unknown account");
  const map = await getSessionMnemonicMap();
  const phrase = phraseFor(account, map) ?? (await getSessionMnemonic());
  if (!phrase) throw new Error("Wallet is locked");
  await browser.storage.session.set({
    [STORAGE_KEYS.sessionActiveAccount]: index,
    [STORAGE_KEYS.sessionMnemonic]: phrase,
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
  // The unlocked phrase lives in storage.session. Chrome keeps that area from
  // content scripts by default; Safari does not say so, and during testing it
  // passed a session change notice to a content script. Ask explicitly.
  const session = browser.storage.session as typeof browser.storage.session & {
    setAccessLevel?: (options: { accessLevel: "TRUSTED_CONTEXTS" }) => Promise<void>;
  };
  if (typeof session.setAccessLevel === "function") {
    void session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => undefined);
  }

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SESSION_CONFIG.autoLock.alarmName) {
      void lockWallet();
    }
  });

  // Locking when the browser closes needs no listener: the browser empties
  // storage.session then. runtime.onSuspend is not that moment. Firefox fires
  // it whenever it unloads an idle background page, about 30 s after the last
  // event, so locking there would lock the wallet while it is in use.

  if (SESSION_CONFIG.autoLock.onDeviceLock && browser.idle?.onStateChanged) {
    browser.idle.onStateChanged.addListener((state) => {
      if (state === "locked") void lockWallet();
    });
  }
}
