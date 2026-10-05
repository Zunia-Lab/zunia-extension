import { STORAGE_KEYS } from "./storage-keys";
import { SECURITY_CONFIG } from "../config/security";
import { SESSION_CONFIG } from "../config/session";

export type ThemePreference = "dark" | "light" | "system";

/**
 * How much of the NFT machinery the screen exposes.
 *
 * `simple` shows collections and nothing else: discovery is automatic, the
 * scan report is one collapsed line and contract addresses never appear.
 * `pro` exposes the parts a power user needs and a newcomer cannot act on -
 * the saved contract list, the per-network scan report, and the switch that
 * turns the chain-wide CW721 scan off.
 */
export type NftMode = "simple" | "pro";

/** Home asset list: one row per token, or tokens nested under their chain. */
export type AssetListMode = "grouped" | "separate";

/** Gas price tier used for every wallet transaction. */
export type FeeSpeedPref = "low" | "average" | "high";

/**
 * How often the "staking rewards ready to claim" reminder comes back while the
 * rewards wait: once until they are claimed, every day, every week, or never.
 */
export type RewardReminder = "once" | "daily" | "weekly" | "off";

/**
 * Which notifications appear: in the feed, on the badges and as browser
 * alerts. Approvals are not a choice: a site is waiting on each one.
 */
export interface NotifyPrefs {
  transfers: boolean;
  unbonding: boolean;
  governance: boolean;
  rewards: RewardReminder;
}

export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = {
  transfers: true,
  unbonding: true,
  governance: true,
  rewards: "once",
};

/** A stored `notify` value, field by field; anything unreadable keeps its default. */
export function parseNotifyPrefs(value: unknown): NotifyPrefs {
  const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const flag = (key: "transfers" | "unbonding" | "governance"): boolean =>
    typeof row[key] === "boolean" ? (row[key] as boolean) : DEFAULT_NOTIFY_PREFS[key];
  const rewards = row.rewards;
  return {
    transfers: flag("transfers"),
    unbonding: flag("unbonding"),
    governance: flag("governance"),
    rewards:
      rewards === "once" || rewards === "daily" || rewards === "weekly" || rewards === "off"
        ? rewards
        : DEFAULT_NOTIFY_PREFS.rewards,
  };
}

/** Fiat display currencies offered in Preferences. */
export const CURRENCIES = ["USD", "EUR", "GBP", "JPY", "CHF"] as const;
export type CurrencyCode = (typeof CURRENCIES)[number];

export interface ExtensionSettings {
  /** Keplr alias on window.keplr, OFF by default. */
  exposeKeplrAlias: boolean;
  /** Allow approving undecoded / unknown msgs, OFF by default. */
  blindSigning: boolean;
  autoLockMs: number;
  /**
   * Re-enter the password for every signature, OFF by default. Enforced in the
   * worker: dApp signatures and wallet transactions are refused without it.
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
  /**
   * Simple or pro on the NFT screen. See {@link NftMode}.
   *
   * A preference rather than screen state so the choice survives closing the
   * popup: a user who added contract addresses expects to still see them.
   */
  nftMode: NftMode;
  /**
   * Home Assets tab. `separate` is one row per denom; `grouped` nests tokens
   * under the chain that holds them.
   */
  assetListMode: AssetListMode;
  /**
   * Walk the chain's own wasm code list looking for CW721 contracts.
   *
   * ON by default, because on a chain with a handful of codes it is the only
   * path that finds a collection nobody configured. It is the expensive path -
   * one request per wasm code on the first run of each chain - so pro mode can
   * turn it off and rely on the saved contract list, which is instant.
   */
  nftAutoScan: boolean;
  /** Anonymous diagnostics - OFF by default. Persisted but not enforced yet. */
  diagnostics: boolean;
  /**
   * A browser notification when a cross-chain transfer or swap settles. Only
   * counts while the browser grants the optional `notifications` permission.
   */
  browserAlerts: boolean;
  /**
   * Gas price tier for every signed transaction: low, mid (`average`), high.
   * Used with {@link gasAdjustment} to price the fee the user sees.
   */
  feeSpeed: FeeSpeedPref;
  /**
   * Multiplier on simulated gas. Default 1.4. Range 1.0 to 2.0.
   */
  gasAdjustment: number;
  /**
   * Swap slippage tolerance, percent on the 0-100 scale the Osmosis
   * swaprouter reads. Default 1. Range (0, 50].
   */
  swapSlippage: number;
  /** Which notifications appear, and how often reward reminders come back. */
  notify: NotifyPrefs;
}

/**
 * Settings that are stored but that no code path reads: nothing reports
 * diagnostics.
 *
 * The fields stay so a preference set today survives until the behaviour ships,
 * but a screen rendering one of these MUST disable the control and show the
 * reason, rather than implying the switch does something. Delete an entry in
 * the same change that makes its setting real.
 */
export const INERT_SETTINGS: Partial<Record<keyof ExtensionSettings, string>> = {
  diagnostics: "Not active yet. Nothing is collected or sent.",
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
  nftMode: "simple",
  assetListMode: "separate",
  nftAutoScan: true,
  diagnostics: false,
  browserAlerts: true,
  feeSpeed: "average",
  gasAdjustment: 1.4,
  swapSlippage: 1,
  notify: DEFAULT_NOTIFY_PREFS,
};

export async function getSettings(): Promise<ExtensionSettings> {
  const result = await browser.storage.local.get(STORAGE_KEYS.settings);
  const stored = result[STORAGE_KEYS.settings] as
    | Partial<ExtensionSettings>
    | undefined;
  const next = { ...DEFAULT_SETTINGS, ...stored };
  if (next.assetListMode !== "grouped" && next.assetListMode !== "separate") {
    next.assetListMode = DEFAULT_SETTINGS.assetListMode;
  }
  if (next.feeSpeed !== "low" && next.feeSpeed !== "average" && next.feeSpeed !== "high") {
    next.feeSpeed = DEFAULT_SETTINGS.feeSpeed;
  }
  if (
    typeof next.gasAdjustment !== "number" ||
    !Number.isFinite(next.gasAdjustment) ||
    next.gasAdjustment < 1 ||
    next.gasAdjustment > 2
  ) {
    next.gasAdjustment = DEFAULT_SETTINGS.gasAdjustment;
  }
  if (
    typeof next.swapSlippage !== "number" ||
    !Number.isFinite(next.swapSlippage) ||
    next.swapSlippage <= 0 ||
    next.swapSlippage > 50
  ) {
    next.swapSlippage = DEFAULT_SETTINGS.swapSlippage;
  }
  next.notify = parseNotifyPrefs(next.notify);
  return next;
}

export async function setSettings(
  patch: Partial<ExtensionSettings>,
): Promise<ExtensionSettings> {
  const next = { ...(await getSettings()), ...patch };
  await browser.storage.local.set({ [STORAGE_KEYS.settings]: next });
  return next;
}
