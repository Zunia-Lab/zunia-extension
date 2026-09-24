/**
 * Typed mirror of config/session.yaml for runtime imports.
 * Keep values in sync with the YAML policy file.
 */
export const SESSION_CONFIG = {
  schemaVersion: 1,
  storage: {
    /**
     * chrome.storage.session: memory only, gone when the browser closes, and not
     * readable by content scripts at the default TRUSTED_CONTEXTS access level.
     */
    decryptedPhraseInSessionStorageOnly: true,
    neverPersistDecryptedToDisk: true,
  },
  autoLock: {
    defaultMs: 600_000,
    minMs: 60_000,
    maxMs: 3_600_000,
    /** Holds by construction: the browser empties storage.session when it closes. */
    onBrowserClose: true,
    onDeviceLock: true,
    lockNowAction: true,
    /**
     * An unlocked wallet page reports input at most this often, and each report
     * restarts the timer, so auto-lock counts time without input.
     */
    activityReportMs: 30_000,
    alarmName: "zunia-autolock",
  },
  password: {
    /** See lib/password-throttle.ts for the schedule. */
    rateLimit: "exponential_backoff" as const,
    perSignatureConfirmation: "opt_in" as const,
  },
} as const;

export type SessionConfig = typeof SESSION_CONFIG;
