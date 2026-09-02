/**
 * Wire format for the in-page connect modal.
 *
 * The modal is an extension-origin iframe (`connect.html`) that the content
 * script mounts inside a closed shadow root. Two channels are involved and it
 * matters which is which:
 *
 * - iframe ↔ background over `browser.runtime` — everything that decides
 *   whether a dApp gets access. The page cannot see or forge it.
 * - iframe → content script over `window.postMessage` — presentation only
 *   ("I finished, take me down", "this is how tall I am"). The dApp is the
 *   parent frame, so anything sent here must be assumed public and must never
 *   be trusted as authorization.
 *
 * Nothing in this module touches extension APIs, so it is unit-testable and
 * safe to import from the content script, the iframe, and the background.
 */

/** Namespaced so a page's own postMessage traffic can never be mistaken for ours. */
export const CONNECT_OVERLAY_CHANNEL = "zunia:connect-overlay";

/** Port name prefix used to tie an iframe's lifetime to a pending approval. */
const CONNECT_PORT_PREFIX = "zunia:connect:";

/** Query parameters the content script puts on the iframe URL. */
export const CONNECT_PARAM = {
  approvalId: "id",
  parentOrigin: "parentOrigin",
  theme: "theme",
} as const;

export type ConnectOverlayOutcome =
  | "approved"
  | "rejected"
  /** Closed without a decision (stale request, unlock abandoned). */
  | "dismissed";

export interface ConnectOverlayResizeMessage {
  channel: typeof CONNECT_OVERLAY_CHANNEL;
  action: "resize";
  approvalId: string;
  height: number;
}

export interface ConnectOverlayDoneMessage {
  channel: typeof CONNECT_OVERLAY_CHANNEL;
  action: "done";
  approvalId: string;
  outcome: ConnectOverlayOutcome;
}

export type ConnectOverlayMessage =
  | ConnectOverlayResizeMessage
  | ConnectOverlayDoneMessage;

/** Modal width from the design mock. */
export const CONNECT_FRAME_WIDTH = 340;
export const CONNECT_FRAME_MIN_HEIGHT = 220;
export const CONNECT_FRAME_MAX_HEIGHT = 560;

/**
 * A hostile page cannot reach into the iframe, but it can resize the viewport.
 * Clamping keeps the modal on screen and stops a bogus height from turning the
 * overlay into a full-page element that hides the rest of the browser UI.
 */
export function clampFrameHeight(height: number, viewportHeight: number): number {
  if (!Number.isFinite(height)) return CONNECT_FRAME_MIN_HEIGHT;
  const ceiling = Math.max(
    CONNECT_FRAME_MIN_HEIGHT,
    Math.min(CONNECT_FRAME_MAX_HEIGHT, Math.round(viewportHeight) - 48),
  );
  return Math.min(ceiling, Math.max(CONNECT_FRAME_MIN_HEIGHT, Math.round(height)));
}

/**
 * Structural validation of a message claiming to come from the modal.
 *
 * This is a shape check only. The caller must *first* prove the message came
 * from the iframe itself (`event.source === iframe.contentWindow` plus an
 * extension-origin `event.origin`); a page can trivially post an object that
 * satisfies everything below.
 */
export function parseConnectOverlayMessage(
  data: unknown,
  expectedApprovalId: string,
): ConnectOverlayMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const message = data as Partial<ConnectOverlayMessage> & { height?: unknown };
  if (message.channel !== CONNECT_OVERLAY_CHANNEL) return null;
  if (message.approvalId !== expectedApprovalId) return null;

  if (message.action === "resize") {
    if (typeof message.height !== "number" || !Number.isFinite(message.height)) {
      return null;
    }
    return {
      channel: CONNECT_OVERLAY_CHANNEL,
      action: "resize",
      approvalId: expectedApprovalId,
      height: message.height,
    };
  }

  if (message.action === "done") {
    const outcome = (message as ConnectOverlayDoneMessage).outcome;
    if (
      outcome !== "approved" &&
      outcome !== "rejected" &&
      outcome !== "dismissed"
    ) {
      return null;
    }
    return {
      channel: CONNECT_OVERLAY_CHANNEL,
      action: "done",
      approvalId: expectedApprovalId,
      outcome,
    };
  }

  return null;
}

export function connectPortName(approvalId: string): string {
  return `${CONNECT_PORT_PREFIX}${approvalId}`;
}

/** Returns the approval id a port claims, or null when the port is unrelated. */
export function approvalIdFromPortName(name: string): string | null {
  if (!name.startsWith(CONNECT_PORT_PREFIX)) return null;
  const id = name.slice(CONNECT_PORT_PREFIX.length);
  return id.length > 0 ? id : null;
}

/** Hostname shown to the user. Never fall back to something that hides the origin. */
export function originHostLabel(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin.replace(/^[a-z]+:\/\//i, "");
  }
}
