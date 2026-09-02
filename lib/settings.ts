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
  /** Re-enter the password for every signature — OFF by default. */
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
  /** Anonymous diagnostics — OFF by default. */
  diagnostics: boolean;
  /** Browser notifications for transfers and governance. */
  browserAlerts: boolean;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  exposeKeplrAlias: false,
  blindSigning: SECURITY_CONFIG.signing.blindSigningDefault,
  autoLockMs: SESSION_CONFIG.autoLock.defaultMs,
  requirePasswordOnSign: false,
  theme: "dark",
  hideBalances: false,
  currency: "USD",
  liveBalances: true,
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
