import { STORAGE_KEYS } from "./storage-keys";
import { SECURITY_CONFIG } from "../config/security";
import { SESSION_CONFIG } from "../config/session";

export type ThemePreference = "dark" | "light" | "system";

/** Fiat display currencies offered in Preferences. */
export const CURRENCIES = ["USD", "EUR", "GBP", "JPY", "CHF"] as const;
export type CurrencyCode = (typeof CURRENCIES)[number];

export interface ExtensionSettings {
  /** Keplr alias on window.keplr — OFF by default. */
  exposeKeplrAlias: boolean;
  /** Allow approving undecoded / unknown msgs — OFF by default. */
  blindSigning: boolean;
  autoLockMs: number;
  /**
   * Re-enter the password for every signature — OFF by default.
   * Persisted but not enforced yet; see INERT_SETTINGS.
   */
  requirePasswordOnSign: boolean;
  theme: ThemePreference;
  /** Mask every amount in the UI behind ••••. */
  hideBalances: boolean;
  currency: CurrencyCode;
  /**
   * Read balances from the public REST endpoint of each enabled chain.
   * Requires the optional host permission the first time it is used.
   */
  liveBalances: boolean;
  /**
   * Load NFT artwork and off-chain `token_uri` metadata - OFF by default.
   *
   * Separate from `liveBalances` because it is a different disclosure to a
   * different party: a chain read goes to the REST host in the chain registry,
   * while artwork goes to whatever host the NFT's minter chose, and only for
   * tokens the user holds. Turning it on tells that host the user's IP address
   * and the shape of their collection. Both switches must be on before anything
   * is fetched.
   */
  nftMedia: boolean;
  /** Anonymous diagnostics - OFF by default. Persisted but not enforced yet. */
  diagnostics: boolean;
  /** Browser notifications for transfers and governance. Not enforced yet. */
  browserAlerts: boolean;
}

/**
 * Settings that are stored but that no code path reads: the signing path never
 * checks requirePasswordOnSign, nothing reports diagnostics, and there is no
 * browser.notifications call anywhere in the extension.
 *
 * The fields stay so a preference set today survives until the behaviour ships,
 * but a screen rendering one of these MUST disable the control and show the
 * reason, rather than implying the switch does something. Delete an entry in
 * the same change that makes its setting real.
 */
export const INERT_SETTINGS: Partial<Record<keyof ExtensionSettings, string>> = {
  requirePasswordOnSign:
    "Not active yet — this turns on when transaction signing ships.",
  diagnostics: "Not active yet — nothing is collected or sent.",
  browserAlerts: "Not active yet — the extension sends no notifications.",
};

export const DEFAULT_SETTINGS: ExtensionSettings = {
  exposeKeplrAlias: false,
  blindSigning: SECURITY_CONFIG.signing.blindSigningDefault,
  autoLockMs: SESSION_CONFIG.autoLock.defaultMs,
  requirePasswordOnSign: false,
  theme: "dark",
  hideBalances: false,
  currency: "USD",
  liveBalances: true,
  // Off: fetching a token_uri is a request to a stranger's server that only
  // happens for tokens this wallet holds, so it is the user's call to make.
  nftMedia: false,
  diagnostics: false,
  browserAlerts: true,
};

export async function getSettings(): Promise<ExtensionSettings> {
  const result = await browser.storage.local.get(STORAGE_KEYS.settings);
  const stored = result[STORAGE_KEYS.settings] as
    | Partial<ExtensionSettings>
    | undefined;
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function setSettings(
  patch: Partial<ExtensionSettings>,
): Promise<ExtensionSettings> {
  const next = { ...(await getSettings()), ...patch };
  await browser.storage.local.set({ [STORAGE_KEYS.settings]: next });
  return next;
}
