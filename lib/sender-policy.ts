/**
 * Who is allowed to send which message to the worker.
 *
 * Content scripts run inside every web page's process. They are our code, but
 * a compromised renderer can speak with their voice, so the worker treats them
 * as the least trusted internal sender: they may forward provider calls and
 * nothing else. The in-page connect frame gets the handful of reads and the one
 * decision it needs. Only full extension pages (popup, approval window,
 * onboarding) reach the wallet itself.
 */

import type { ExtensionMessageType } from "./messaging";

export type SenderKind =
  | "extension-page"
  | "connect-frame"
  | "content-script"
  | "external"
  | "unknown";

export interface SenderLike {
  id?: string;
  url?: string;
  origin?: string;
  tab?: { id?: number };
  frameId?: number;
}

export interface SenderContext {
  extensionId: string;
  /** `browser.runtime.getURL("/")`, e.g. `chrome-extension://<id>/`. */
  extensionBaseUrl: string;
  /** True when the message arrived through `onMessageExternal`. */
  external: boolean;
}

const CONNECT_FRAME_PATH = "/connect.html";

export function classifySender(sender: SenderLike, ctx: SenderContext): SenderKind {
  if (ctx.external) return "external";
  if (sender.id !== ctx.extensionId) return "unknown";
  const url = sender.url ?? "";
  if (url.startsWith(ctx.extensionBaseUrl)) {
    try {
      return new URL(url).pathname === CONNECT_FRAME_PATH ? "connect-frame" : "extension-page";
    } catch {
      return "unknown";
    }
  }
  return sender.tab ? "content-script" : "unknown";
}

const CONTENT_SCRIPT_MESSAGES: ReadonlySet<ExtensionMessageType> = new Set([
  "PROVIDER_REQUEST",
]);

const CONNECT_FRAME_MESSAGES: ReadonlySet<ExtensionMessageType> = new Set([
  "GET_STATUS",
  "GET_SETTINGS",
  "GET_PENDING_APPROVALS",
  "GET_ACCOUNT_ADDRESSES",
  "SET_ACTIVE_ACCOUNT",
  "RESOLVE_APPROVAL",
  "REJECT_APPROVAL",
]);

const EXTERNAL_MESSAGES: ReadonlySet<ExtensionMessageType> = new Set([
  "PING",
  "GET_STATUS",
]);

/** Messages only a full extension page may send, never a provider path. */
const EXTENSION_ONLY_BLOCKED: ReadonlySet<ExtensionMessageType> = new Set([
  "PROVIDER_REQUEST",
  "SHOW_CONNECT_OVERLAY",
]);

export function messageAllowed(kind: SenderKind, type: ExtensionMessageType): boolean {
  switch (kind) {
    case "extension-page":
      return !EXTENSION_ONLY_BLOCKED.has(type);
    case "connect-frame":
      return CONNECT_FRAME_MESSAGES.has(type);
    case "content-script":
      return CONTENT_SCRIPT_MESSAGES.has(type);
    case "external":
      return EXTERNAL_MESSAGES.has(type);
    default:
      return false;
  }
}

/**
 * The origin of the page behind a provider request, taken from what the browser
 * says about the sender. Anything the message body claims is ignored. Opaque
 * origins (sandboxed frames, data: URLs) have no identity to grant access to.
 */
export function providerOriginFromSender(sender: SenderLike): string | null {
  let origin = sender.origin;
  if (!origin && sender.url) {
    try {
      origin = new URL(sender.url).origin;
    } catch {
      return null;
    }
  }
  if (!origin || origin === "null") return null;
  if (!/^https?:\/\//.test(origin)) return null;
  return origin;
}
