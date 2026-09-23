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
    /** The request origin comes from the browser's sender record, never the message body. */
    originFromSender: true,
    /**
     * Connection prompts may render in-page, inside a closed shadow root, only where
     * the browser can prove the frame is visible and unobstructed. Everything that
     * signs stays in the extension popup or window.
     */
    connectPromptInPage: "visibility_verified_only" as const,
    signingUi: "extension_popup_or_window" as const,
  },
  approvals: {
    /** A request nobody answers is rejected after this long. */
    ttlMs: 5 * 60 * 1000,
    /** Closing the popup or window that shows a request rejects it. */
    rejectOnUiClose: true,
  },
  rateLimits: {
    maxPendingApprovals: 3,
    queueExtraPrompts: true,
  },
  signing: {
    blindSigningDefault: false,
    warnUnknownMsgs: true,
    warnFirstTimeRecipient: true,
    /** A document whose chain differs from the requested chain is refused, not warned about. */
    refuseChainIdMismatch: true,
    /** The signer a dApp names must be the active account. */
    requireActiveSigner: true,
  },
  phishing: {
    /** Lookalike, punycode and raw-IP warnings computed locally from the origin. */
    lookalikeWarning: true,
    /** No remote blocklist is consulted. */
    remoteBlocklist: false,
  },
} as const;

export type SecurityConfig = typeof SECURITY_CONFIG;
