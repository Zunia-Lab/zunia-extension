/**
 * Codes a page can branch on. They cross the worker, the content script and
 * the page next to the message, which keeps Keplr's wording where Keplr has
 * one ("Request rejected", "Not authorized") so dApps matching on text keep
 * working.
 */
export const PROVIDER_ERROR_CODES = [
  /** The user said no, closed the prompt, or let it expire. */
  "USER_REJECTED",
  /** The site has no live grant for that chain. */
  "NOT_CONNECTED",
  /** The wallet is locked and was not unlocked in time. */
  "LOCKED",
  /** The chain is not in the wallet. */
  "UNKNOWN_CHAIN",
  /** The request does not come from the site it names. */
  "ORIGIN_MISMATCH",
  /** The method exists but Zunia will not do it. */
  "UNSUPPORTED",
  /** Missing or malformed arguments, or a signer that is not the active account. */
  "INVALID_PARAMS",
  /** Anything else. */
  "INTERNAL",
] as const;

export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;

  constructor(code: ProviderErrorCode, message: string) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
  }
}

export function isProviderErrorCode(value: unknown): value is ProviderErrorCode {
  return (
    typeof value === "string" && (PROVIDER_ERROR_CODES as readonly string[]).includes(value)
  );
}

/** The code for any error that reaches the bridge. */
export function providerErrorCode(err: unknown): ProviderErrorCode {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return isProviderErrorCode(code) ? code : "INTERNAL";
}
