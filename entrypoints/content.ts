import { CONNECT_CONFIG } from "../config/connect";
import { createConnectOverlay } from "../lib/connect-overlay-view";
import { PAGE_CHANNEL } from "../lib/messaging";
import type { ExtensionMessage, ExtensionResponse } from "../lib/messaging";
import { getSettings } from "../lib/settings";
import { STORAGE_KEYS } from "../lib/storage-keys";
import "./style.css";

/**
 * Isolated-world content script:
 * 1. Injects the MAIN-world provider with a nonce.
 * 2. Completes a MessageChannel handshake (origin-checked both sides).
 * 3. Proxies provider RPC to the background with the page origin.
 * 4. Hosts the in-page connect modal on request from the background.
 */
export default defineContentScript({
  matches: [...CONNECT_CONFIG.contentScriptMatches],
  runAt: "document_start",
  world: "ISOLATED",
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

    async function forwardToBackground(
      method: string,
      args: unknown[],
    ): Promise<unknown> {
      const message: ExtensionMessage = {
        type: "PROVIDER_REQUEST",
        origin: pageOrigin,
        payload: { method, args },
      };
      const response = (await browser.runtime.sendMessage(
        message,
      )) as ExtensionResponse;
      if (!response?.ok) {
        throw new Error(response?.error ?? "Provider request failed");
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
            });
          });
      };

      window.postMessage(
        { type: PAGE_CHANNEL.handshakeAck, nonce },
        pageOrigin,
        [channel.port2],
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
     * traffic — a web page cannot post here — but the sender id is checked
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
      if (overlay.isActive()) {
        return { ok: true, data: { shown: false } };
      }
      const shown = await overlay.show(approvalId, await resolvedTheme());
      return { ok: true, data: { shown } };
    }

    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (sender.id && sender.id !== browser.runtime.id) return false;
      const typed = message as ExtensionMessage;
      if (typed?.type !== "SHOW_CONNECT_OVERLAY") return false;
      void handleShowConnectOverlay(typed.payload).then(sendResponse);
      return true;
    });

    window.addEventListener("message", onWindowMessage);
    injectProvider();

    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" && area !== "session") return;
      if (!port) return;
      if (changes[STORAGE_KEYS.settings]) {
        const next = changes[STORAGE_KEYS.settings].newValue as
          | { exposeKeplrAlias?: boolean }
          | undefined;
        port.postMessage({
          type: PAGE_CHANNEL.event,
          event: "settingsChanged",
          data: { exposeKeplrAlias: Boolean(next?.exposeKeplrAlias) },
        });
      }
      if (
        changes[STORAGE_KEYS.sessionActiveAccount] ||
        changes[STORAGE_KEYS.accounts]
      ) {
        port.postMessage({
          type: PAGE_CHANNEL.event,
          event: "accountsChanged",
          data: null,
        });
      }
    });
  },
});
