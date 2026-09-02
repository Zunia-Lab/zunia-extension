/**
 * Typed mirror of config/security.yaml for runtime imports.
 * Keep values in sync with the YAML policy file.
 */
export const SECURITY_CONFIG = {
  schemaVersion: 1,
  permissions: {
    perOrigin: true,
    perChain: true,
    revocable: true,
    listedInSettings: true,
    expireSessions: true,
    /** Default grant lifetime (7 days). */
    defaultTtlMs: 7 * 24 * 60 * 60 * 1000,
  },
  provider: {
    noPostMessageWildcard: true,
    originCheckBothSides: true,
    isolatedMessageChannel: true,
    approvalUi: "extension_popup_or_window" as const,
    neverInPageIframe: true,
  },
  rateLimits: {
    maxPendingApprovals: 3,
    queueExtraPrompts: true,
  },
  signing: {
    blindSigningDefault: false,
    warnUnknownMsgs: true,
    warnFirstTimeRecipient: true,
    warnChainIdMismatch: true,
  },
} as const;

export type SecurityConfig = typeof SECURITY_CONFIG;
