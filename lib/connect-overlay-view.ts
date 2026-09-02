import tokensCss from "@zunialab/tokens/tokens.css?inline";
import {
  CONNECT_FRAME_MIN_HEIGHT,
  CONNECT_FRAME_WIDTH,
  CONNECT_PARAM,
  clampFrameHeight,
  originHostLabel,
  parseConnectOverlayMessage,
  type ConnectOverlayOutcome,
} from "./connect-overlay";

/**
 * Page-side chrome for the in-page connect modal: a scrim, the extension-origin
 * iframe that actually renders the prompt, and the confirmation toast.
 *
 * Threat model for this file:
 *
 * - Everything here lives in the content script's isolated world and inside a
 *   *closed* shadow root, so page script has no handle on the subtree and
 *   cannot read the prompt, click its buttons, or restyle it.
 * - The iframe is a different origin from the page, so even with a reference to
 *   the element the page cannot reach `contentDocument`.
 * - This file never approves or rejects anything. The worst a hostile page can
 *   do is destroy the overlay, which the background reads as "prompt gone" and
 *   turns into a rejection. Denial of its own request, nothing more.
 * - A page can still stack its own content above us. That is exactly why only
 *   connection prompts live here; signing and broadcasting stay in the toolbar
 *   popup, which page content cannot paint over.
 */

const HOST_TAG = "zunia-connect-overlay";
const TOAST_MS = 4_500;
const FRAME_LOAD_TIMEOUT_MS = 3_000;

/**
 * Tokens are authored against `:root`, which never matches inside a shadow
 * tree. Rehoming them onto `:host` gives the overlay the real palette instead
 * of a hand-copied subset that would drift from the design system.
 */
const scopedTokensCss = tokensCss.replace(/:root\b/g, ":host");

/**
 * The page has not loaded Zunia's webfonts and we do not want to make them
 * web-accessible just for a toast, so the shadow tree falls back to system UI
 * faces while keeping the token stack first in line.
 */
const overlayCss = `
.root {
  position: fixed;
  inset: 0;
  font-family: var(--z-font-sans);
  color: var(--z-fg);
  -webkit-font-smoothing: antialiased;
}

.scrim {
  position: absolute;
  inset: 0;
  background: var(--z-overlay);
  animation: z-fade var(--z-duration-base) var(--z-ease) both;
}

.frame {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: ${CONNECT_FRAME_WIDTH}px;
  border-radius: 22px;
  overflow: hidden;
  background: var(--z-surface-raised);
  box-shadow: 0 30px 60px var(--z-shadow);
  animation: z-pop var(--z-duration-base) var(--z-ease) both;
}

.frame iframe {
  display: block;
  width: 100%;
  height: ${CONNECT_FRAME_MIN_HEIGHT}px;
  border: 0;
  background: transparent;
  transition: height var(--z-duration-base) var(--z-ease);
}

.toast {
  position: absolute;
  right: 18px;
  top: 18px;
  width: 264px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 13px;
  border: 1px solid var(--z-info-line);
  border-radius: 14px;
  background: var(--z-surface-raised);
  box-shadow: 0 18px 36px var(--z-shadow);
  animation: z-slide var(--z-duration-base) var(--z-ease) both;
}

.toast-icon {
  flex: none;
  width: 26px;
  height: 26px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  background-image: var(--z-accent-gradient);
  box-shadow: var(--z-accent-glow);
  color: var(--z-accent-fg);
  font-size: 13px;
  line-height: 1;
}

.toast-text {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
  font-weight: 500;
  line-height: 1.35;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.toast-close {
  flex: none;
  border: 0;
  padding: 0;
  width: 18px;
  height: 18px;
  cursor: pointer;
  background: transparent;
  color: var(--z-fg-faint);
  font: inherit;
  font-size: 12px;
  line-height: 1;
}

.toast-close:hover {
  color: var(--z-fg);
}

@keyframes z-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes z-pop {
  from { opacity: 0; transform: translate(-50%, -46%) scale(0.98); }
  to { opacity: 1; transform: translate(-50%, -50%) scale(1); }
}

@keyframes z-slide {
  from { opacity: 0; transform: translateY(-8px); }
  to { opacity: 1; transform: none; }
}

@media (prefers-reduced-motion: reduce) {
  .scrim, .frame, .toast { animation: none; }
  .frame iframe { transition: none; }
}
`;

type ResolvedTheme = "dark" | "light";

interface ActiveOverlay {
  approvalId: string;
  host: HTMLElement;
  root: HTMLElement;
  frame: HTMLElement;
  iframe: HTMLIFrameElement;
}

export interface ConnectOverlayController {
  /** Resolves true once the prompt is actually on screen. */
  show(approvalId: string, theme: ResolvedTheme): Promise<boolean>;
  isActive(): boolean;
}

function extensionOrigin(): string {
  return new URL(browser.runtime.getURL("/" as never)).origin;
}

/**
 * Pin the host element down with `!important` so page stylesheets cannot hide
 * or displace the prompt. `all: initial` first, so inherited page styles do not
 * leak into the host box.
 */
function lockHostStyle(host: HTMLElement): void {
  const style = host.style;
  style.setProperty("all", "initial", "important");
  style.setProperty("display", "block", "important");
  style.setProperty("position", "fixed", "important");
  style.setProperty("inset", "0", "important");
  style.setProperty("width", "100%", "important");
  style.setProperty("height", "100%", "important");
  style.setProperty("margin", "0", "important");
  style.setProperty("border", "0", "important");
  style.setProperty("z-index", "2147483647", "important");
  style.setProperty("color-scheme", "normal", "important");
}

export function createConnectOverlay(): ConnectOverlayController {
  let active: ActiveOverlay | null = null;
  let toastTimer: number | undefined;

  function teardown(): void {
    if (!active) return;
    const { host } = active;
    active = null;
    window.clearTimeout(toastTimer);
    host.remove();
  }

  function showToast(host: HTMLElement, root: HTMLElement): void {
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.setAttribute("role", "status");

    const icon = document.createElement("span");
    icon.className = "toast-icon";
    icon.textContent = "✓";
    icon.setAttribute("aria-hidden", "true");

    const text = document.createElement("span");
    text.className = "toast-text";
    // textContent, never innerHTML: the hostname comes from the page's own URL.
    text.textContent = `Connected to ${originHostLabel(window.location.origin)}`;

    const close = document.createElement("button");
    close.type = "button";
    close.className = "toast-close";
    close.setAttribute("aria-label", "Dismiss");
    close.textContent = "✕";
    close.addEventListener("click", () => host.remove());

    toast.append(icon, text, close);
    root.append(toast);

    toastTimer = window.setTimeout(() => host.remove(), TOAST_MS);
  }

  function finish(outcome: ConnectOverlayOutcome): void {
    if (!active) return;
    const { host, root, frame } = active;
    // Drop the prompt first: the frame going away is what tells the background
    // the user can no longer answer.
    frame.remove();

    if (outcome !== "approved") {
      teardown();
      return;
    }

    const scrim = root.querySelector(".scrim");
    scrim?.remove();
    // The toast is a notification, not a prompt, so it must not keep blocking
    // the page underneath it.
    host.style.setProperty("pointer-events", "none", "important");
    showToast(host, root);
    active = null;
  }

  function onWindowMessage(event: MessageEvent): void {
    const current = active;
    if (!current) return;
    // The page shares this window and can post anything. Identity of the sender
    // is the only thing that separates the real prompt from a forgery, so check
    // the frame handle first and the extension origin second.
    if (event.source !== current.iframe.contentWindow) return;
    if (event.origin !== extensionOrigin()) return;

    const message = parseConnectOverlayMessage(event.data, current.approvalId);
    if (!message) return;

    if (message.action === "resize") {
      current.iframe.style.height = `${clampFrameHeight(
        message.height,
        window.innerHeight,
      )}px`;
      return;
    }

    finish(message.outcome);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (!active) return;
    // Synthetic key events are page-authored; only a real keypress dismisses.
    if (!event.isTrusted) return;
    if (event.key !== "Escape") return;
    teardown();
  }

  window.addEventListener("message", onWindowMessage);
  window.addEventListener("keydown", onKeyDown, true);

  return {
    isActive: () => active !== null,

    async show(approvalId: string, theme: ResolvedTheme): Promise<boolean> {
      if (active) return false;
      if (!approvalId) return false;

      const host = document.createElement(HOST_TAG);
      lockHostStyle(host);

      /*
       * Closed mode: `host.shadowRoot` stays null for page script, so a dApp
       * cannot walk into the prompt. The content script runs in an isolated
       * world with its own copy of the DOM prototypes, so a page that patched
       * `Element.prototype.attachShadow` before us cannot intercept this call.
       */
      const shadow = host.attachShadow({ mode: "closed" });

      const tokenStyle = document.createElement("style");
      tokenStyle.textContent = scopedTokensCss;
      const overlayStyle = document.createElement("style");
      overlayStyle.textContent = overlayCss;

      const root = document.createElement("div");
      root.className = "root";
      root.dataset.theme = theme;

      const scrim = document.createElement("div");
      scrim.className = "scrim";

      const frame = document.createElement("div");
      frame.className = "frame";

      const url = new URL(browser.runtime.getURL("/connect.html" as never));
      url.searchParams.set(CONNECT_PARAM.approvalId, approvalId);
      url.searchParams.set(CONNECT_PARAM.parentOrigin, window.location.origin);
      url.searchParams.set(CONNECT_PARAM.theme, theme);

      const iframe = document.createElement("iframe");
      iframe.title = "Zunia connection request";
      iframe.setAttribute("referrerpolicy", "no-referrer");
      // Deliberately not sandboxed: a sandboxed frame gets an opaque origin and
      // loses access to browser.runtime, which is how the prompt reaches the
      // background. Isolation here comes from the extension origin itself.
      iframe.src = url.toString();

      frame.append(iframe);
      root.append(scrim, frame);
      shadow.append(tokenStyle, overlayStyle, root);
      (document.body ?? document.documentElement).append(host);

      active = { approvalId, host, root, frame, iframe };

      const loaded = await new Promise<boolean>((resolve) => {
        const timer = window.setTimeout(() => resolve(false), FRAME_LOAD_TIMEOUT_MS);
        iframe.addEventListener(
          "load",
          () => {
            window.clearTimeout(timer);
            resolve(true);
          },
          { once: true },
        );
      });

      if (!loaded) {
        // Never report success we cannot back up: the caller falls back to the
        // toolbar popup so the request still reaches the user.
        teardown();
        return false;
      }

      return true;
    },
  };
}
