/**
 * Typed mirror of config/session.yaml for runtime imports.
 * Keep values in sync with the YAML policy file.
 */
export const SESSION_CONFIG = {
  schemaVersion: 1,
  storage: {
    decryptedKeyInServiceWorkerMemoryOnly: true,
    neverPersistDecryptedToChromeStorage: true,
  },
  autoLock: {
    defaultMs: 600_000,
    minMs: 60_000,
    maxMs: 3_600_000,
    onBrowserClose: true,
    onDeviceLock: true,
    lockNowAction: true,
    alarmName: "zunia-autolock",
  },
  password: {
    rateLimit: "exponential_backoff" as const,
    wipeAfterNFailuresOptIn: true,
  },
} as const;

export type SessionConfig = typeof SESSION_CONFIG;
