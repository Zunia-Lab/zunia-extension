import { CONNECT_CONFIG } from "../config/connect";
import { SECURITY_CONFIG } from "../config/security";
import { createConnectOverlay } from "../lib/connect-overlay-view";
import { EVENT_PORT, type EventPortMessage } from "../lib/event-port";
import { PAGE_CHANNEL } from "../lib/messaging";
import type { ExtensionMessage, ExtensionResponse } from "../lib/messaging";
import { providerErrorCode, type ProviderErrorCode } from "../lib/provider-errors";
import { pageEventFor } from "../lib/provider-events";
import { getSettings } from "../lib/settings";
import { STORAGE_KEYS } from "../lib/storage-keys";
import "./style.css";

class BridgeError extends Error {
  constructor(
    message: string,
    readonly code: ProviderErrorCode,
  ) {
    super(message);
  }
}

/**
 * Isolated-world content script:
 * 1. Injects the MAIN-world provider with a nonce.
 * 2. Completes a MessageChannel handshake (origin-checked both sides).
 * 3. Proxies provider RPC to the background with the page origin.
 * 4. Hosts the in-page connect modal on request from the background.
 * 5. Passes the page the wallet events addressed to its origin.
 */
export default defineContentScript({
  matches: [...CONNECT_CONFIG.contentScriptMatches],
  runAt: "document_start",
  main() {
    const pageOrigin = window.location.origin;
    const nonce = crypto.randomUUID();
    let port: MessagePort | null = null;
    const overlay = createConnectOverlay();

    function injectProvider(): void {
      const script = document.createElement("script");
      script.src = browser.runtime.getURL("/injected.js");
      script.dataset.zuniaNonce = nonce;
      script.dataset.zuniaOrigin = pageOrigin;
      script.async = false;
      (document.documentElement || document.head || document.body).appendChild(
        script,
      );
      script.addEventListener("load", () => script.remove());
    }

    // Safari never hands this script the worker's tabs.sendMessage, so there a
    // page that has used the provider gets its events over a port it opens.
    // See lib/event-port.ts.
    const eventsOverPort = import.meta.env.BROWSER === "safari";
    let usesProvider = false;
    let eventPort: ReturnType<typeof browser.runtime.connect> | null = null;
    let lastEventSeq = 0;

    function openEventPort(): void {
      const next = browser.runtime.connect({ name: EVENT_PORT });
      next.onMessage.addListener((message: unknown) => {
        const batch = message as EventPortMessage | null;
        if (batch?.type !== "events") return;
        for (const item of batch.events) {
          if (item.seq <= lastEventSeq) continue;
          lastEventSeq = item.seq;
          handleProviderEvent(item);
        }
        lastEventSeq = Math.max(lastEventSeq, batch.seq);
      });
      next.onDisconnect.addListener(() => {
        if (eventPort === next) eventPort = null;
      });
      const resume: EventPortMessage = { type: "resume", after: lastEventSeq };
      next.postMessage(resume);
      eventPort = next;
    }

    // Browsers stop an idle extension worker (Safari on iOS within seconds),
    // and what it holds goes with it: a request waiting on the user, or on
    // Safari the event port. Ping while either needs it.
    let openRequests = 0;
    let keepAlive: ReturnType<typeof setInterval> | undefined;
    const ping: ExtensionMessage = { type: "PING" };

    function wantsEvents(): boolean {
      return eventsOverPort && usesProvider && document.visibilityState === "visible";
    }

    function tick(): void {
      if (openRequests === 0 && !wantsEvents()) {
        clearInterval(keepAlive);
        keepAlive = undefined;
        return;
      }
      void browser.runtime.sendMessage(ping).catch(() => undefined);
      if (wantsEvents() && !eventPort) openEventPort();
    }

    function keepWorkerUp(): void {
      keepAlive ??= setInterval(tick, SECURITY_CONFIG.approvals.keepAliveMs);
    }

    function startEvents(): void {
      // Events are for the top document, as on the tabs.sendMessage path.
      if (!eventsOverPort || usesProvider || window.top !== window.self) return;
      usesProvider = true;
      // Sequence numbers are timestamps: start from now, not from history.
      lastEventSeq = Date.now() - 1;
      openEventPort();
    }

    // Coming back to the tab: connect again and collect what was missed.
    document.addEventListener("visibilitychange", () => {
      if (!wantsEvents()) return;
      if (!eventPort) openEventPort();
      keepWorkerUp();
    });

    async function forwardToBackground(
      method: string,
      args: unknown[],
    ): Promise<unknown> {
      const message: ExtensionMessage = {
        type: "PROVIDER_REQUEST",
        origin: pageOrigin,
        payload: { method, args },
      };
      startEvents();
      openRequests += 1;
      keepWorkerUp();
      let response: ExtensionResponse;
      try {
        response = (await browser.runtime.sendMessage(
          message,
        )) as ExtensionResponse;
      } finally {
        openRequests -= 1;
      }
      if (!response?.ok) {
        throw new BridgeError(
          response?.error ?? "Provider request failed",
          providerErrorCode(response),
        );
      }
      return response.data;
    }

    function onWindowMessage(event: MessageEvent): void {
      if (event.source !== window) return;
      if (event.origin !== pageOrigin) return;
      const data = event.data as {
        type?: string;
        nonce?: string;
      } | null;
      if (!data || data.type !== PAGE_CHANNEL.handshake) return;
      if (data.nonce !== nonce) return;

      const channel = new MessageChannel();
      port = channel.port1;
      port.onmessage = (portEvent: MessageEvent) => {
        const req = portEvent.data as {
          id?: string;
          method?: string;
          args?: unknown[];
        };
        if (!req?.id || !req.method) return;
        void forwardToBackground(req.method, req.args ?? [])
          .then((result) => {
            port?.postMessage({ id: req.id, result });
          })
          .catch((err: unknown) => {
            port?.postMessage({
              id: req.id,
              error: err instanceof Error ? err.message : String(err),
              code: providerErrorCode(err),
            });
          });
      };

      window.postMessage(
        { type: PAGE_CHANNEL.handshakeAck, nonce },
        pageOrigin,
        [channel.port2],
      );

      // The alias setting only arrives as a change event otherwise, so a page
      // loaded after the user turned it on would never see window.keplr.
      void getSettings()
        .then((settings) => {
          port?.postMessage({
            type: PAGE_CHANNEL.event,
            event: "settingsChanged",
            data: { exposeKeplrAlias: Boolean(settings.exposeKeplrAlias) },
          });
        })
        .catch(() => undefined);
    }

    /**
     * The in-page prompt is only safe where the browser can report whether the
     * frame is actually visible and unobstructed (IntersectionObserver v2).
     * Without that, a page could fade the prompt out or lay a decoy over it and
     * steer a click, so the request goes to the popup instead.
     */
    function canVerifyFrameVisibility(): boolean {
      return (
        typeof IntersectionObserverEntry !== "undefined" &&
        "isVisible" in IntersectionObserverEntry.prototype
      );
    }

    async function resolvedTheme(): Promise<"dark" | "light"> {
      try {
        const settings = await getSettings();
        if (settings.theme === "dark" || settings.theme === "light") {
          return settings.theme;
        }
      } catch {
        // Storage unavailable in this frame; fall back to the page preference.
      }
      return window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark";
    }

    /**
     * Background asks this tab to raise the connect prompt.
     *
     * `browser.runtime.onMessage` in a content script only receives extension
     * traffic (a web page cannot post here), but the sender id is checked
     * anyway, and the payload origin has to match this document. A prompt that
     * named some other site would be a phishing surface, not a bug.
     */
    async function handleShowConnectOverlay(
      payload: unknown,
    ): Promise<ExtensionResponse> {
      const { approvalId, origin } = (payload ?? {}) as {
        approvalId?: string;
        origin?: string;
      };
      if (!approvalId || origin !== pageOrigin) {
        return { ok: false, error: "Overlay request rejected" };
      }
      // Only the top document draws the prompt: a modal inside a nested frame
      // is trivially clipped or hidden by the embedder.
      if (window.top !== window.self) {
        return { ok: true, data: { shown: false } };
      }
      if (overlay.isActive() || !canVerifyFrameVisibility()) {
        return { ok: true, data: { shown: false } };
      }
      const shown = await overlay.show(approvalId, await resolvedTheme());
      return { ok: true, data: { shown } };
    }

    /** Relay a wallet event to the page, if it is addressed to this origin. */
    function handleProviderEvent(payload: unknown): void {
      const relayed = pageEventFor(payload, pageOrigin);
      if (!port || !relayed) return;
      port.postMessage({ type: PAGE_CHANNEL.event, ...relayed });
    }

    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (sender.id !== browser.runtime.id) return false;
      // Only the worker talks to content scripts. Extension pages broadcast to
      // each other on the same channel, and those messages are not for us.
      if (sender.url && !sender.url.startsWith(browser.runtime.getURL("/" as never))) {
        return false;
      }
      const typed = message as ExtensionMessage;
      if (typed?.type === "PROVIDER_EVENT") {
        handleProviderEvent(typed.payload);
        return false;
      }
      if (typed?.type !== "SHOW_CONNECT_OVERLAY") return false;
      void handleShowConnectOverlay(typed.payload).then(sendResponse);
      return true;
    });

    window.addEventListener("message", onWindowMessage);
    injectProvider();

    // Account and connection changes arrive from the worker as PROVIDER_EVENT
    // (or on Safari over the event port), addressed to connected sites only.
    // The alias setting is not about any site, so every page follows it here.
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !port || !changes[STORAGE_KEYS.settings]) return;
      const next = changes[STORAGE_KEYS.settings].newValue as
        | { exposeKeplrAlias?: boolean }
        | undefined;
      port.postMessage({
        type: PAGE_CHANNEL.event,
        event: "settingsChanged",
        data: { exposeKeplrAlias: Boolean(next?.exposeKeplrAlias) },
      });
    });
  },
});
