/**
 * The extension surfaces that can answer a request: the toolbar popup, the
 * approval window, or popup.html in a tab. Each one holds a port named
 * {@link APPROVAL_UI_PORT} for as long as it is open, which is how the worker
 * knows whether a request has somewhere to be shown and when that surface was
 * closed without an answer.
 */

import { SECURITY_CONFIG } from "../config/security";

export const APPROVAL_UI_PORT = "zunia:approval-ui";

type Port = ReturnType<typeof browser.runtime.connect>;

const ports = new Set<Port>();
const closeListeners = new Set<() => void>();
let windowOpening: Promise<void> | null = null;

export function approvalUiOpen(): boolean {
  return ports.size > 0;
}

/** Fires when the last open approval surface goes away. */
export function onApprovalUiClosed(listener: () => void): () => void {
  closeListeners.add(listener);
  return () => closeListeners.delete(listener);
}

export function registerApprovalUiPort(port: Port): void {
  ports.add(port);
  port.onDisconnect.addListener(() => {
    ports.delete(port);
    if (ports.size > 0 || !SECURITY_CONFIG.approvals.rejectOnUiClose) return;
    for (const listener of closeListeners) {
      try {
        listener();
      } catch (err) {
        console.error("[zunia] approval UI close listener failed", err);
      }
    }
  });
}

async function openNow(): Promise<void> {
  try {
    if (browser.action?.openPopup) {
      await browser.action.openPopup();
      return;
    }
  } catch {
    // No focused window or no gesture: fall through to a window.
  }
  const url = browser.runtime.getURL("popup.html" as never);
  // windows.create sizes the OUTER frame, so the title bar and borders come out
  // of the height given here: asking for 600 leaves roughly 565 of viewport and
  // pushes the approval footer off-screen. Ask for the chrome back. The exact
  // overhead differs per platform, so popup/style.css also lets the document
  // adapt down instead of relying on this number being right everywhere.
  await browser.windows.create({
    url: `${url}?approve=1`,
    type: "popup",
    width: 360,
    height: 640,
  });
}

/**
 * Bring up a surface that can show the queue. A no-op when one is already open,
 * which is what keeps a burst of requests from stacking windows.
 */
export async function openApprovalUi(): Promise<void> {
  if (approvalUiOpen()) return;
  if (!windowOpening) {
    windowOpening = openNow().finally(() => {
      // Give the new page a moment to connect its port before another request
      // decides nothing is open and opens a second window.
      setTimeout(() => {
        windowOpening = null;
      }, 1_500);
    });
  }
  return windowOpening;
}
