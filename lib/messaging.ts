import { CONNECT_CONFIG } from "../config/connect";

/** Allowed origins for chrome.runtime external messages. */
export function isExternallyConnectableOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    const host = url.hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") {
      return true;
    }
    if (host === "zuniawallet.com" || host.endsWith(".zuniawallet.com")) {
      return true;
    }
    return CONNECT_CONFIG.externallyConnectableMatches.some((pattern) =>
      matchOriginPattern(origin, pattern),
    );
  } catch {
    return false;
  }
}

export function matchOriginPattern(origin: string, pattern: string): boolean {
  // Patterns look like https://*.zuniawallet.com/* or http://localhost/*
  const normalized = pattern.replace(/\/\*$/, "");
  try {
    const originUrl = new URL(origin);
    const patternUrl = new URL(normalized.includes("://") ? normalized : `https://${normalized}`);
    if (originUrl.protocol !== patternUrl.protocol) return false;
    const pHost = patternUrl.hostname;
    if (pHost.startsWith("*.")) {
      const suffix = pHost.slice(1); // .example.com
      return (
        originUrl.hostname === pHost.slice(2) ||
        originUrl.hostname.endsWith(suffix)
      );
    }
    return originUrl.hostname === pHost;
  } catch {
    return false;
  }
}

export type ExtensionMessageType =
  | "PING"
  | "GET_STATUS"
  | "CREATE_WALLET"
  | "GENERATE_MNEMONIC"
  | "IMPORT_WALLET"
  | "UNLOCK"
  | "LOCK"
  | "GET_ACCOUNTS"
  | "GET_CHAIN_ACCOUNTS"
  | "GET_ACCOUNT_ADDRESSES"
  | "SET_ACTIVE_ACCOUNT"
  | "ADD_ACCOUNT"
  | "RENAME_ACCOUNT"
  | "GET_ENABLED_CHAINS"
  | "SET_ENABLED_CHAINS"
  | "LIST_CUSTOM_CHAINS"
  | "SAVE_CUSTOM_CHAIN"
  | "REMOVE_CUSTOM_CHAIN"
  | "GET_BALANCES"
  | "GET_PRICES"
  | "GET_VALIDATORS"
  | "GET_DELEGATIONS"
  | "GET_UNBONDING"
  | "GET_PROPOSALS"
  | "GET_ACTIVITY"
  | "FIND_IBC_CHANNELS"
  | "VALIDATE_IBC_CHANNEL"
  | "LIST_ADDRESS_BOOK"
  | "SAVE_ADDRESS_BOOK_ENTRY"
  | "REMOVE_ADDRESS_BOOK_ENTRY"
  | "REVEAL_MNEMONIC"
  | "RESET_WALLET"
  | "LIST_PERMISSIONS"
  | "REVOKE_PERMISSION"
  | "GET_SETTINGS"
  | "SET_SETTINGS"
  | "GET_PENDING_APPROVALS"
  | "RESOLVE_APPROVAL"
  | "REJECT_APPROVAL"
  | "PROVIDER_REQUEST"
  | "TOUCH_SESSION"
  /** Background → content script: mount the in-page connect modal. */
  | "SHOW_CONNECT_OVERLAY";

export interface ExtensionMessage {
  type: ExtensionMessageType;
  payload?: unknown;
  /** Set by content script for provider calls. */
  origin?: string;
}

export interface ExtensionResponse {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export const PAGE_CHANNEL = {
  handshake: "zunia:handshake",
  handshakeAck: "zunia:handshake-ack",
  event: "zunia:event",
} as const;

export function assertInternalSender(
  sender: { id?: string; origin?: string; url?: string },
  extensionId: string,
): boolean {
  // Messages from extension pages / content scripts share the extension id.
  if (sender.id && sender.id !== extensionId) return false;
  return true;
}
