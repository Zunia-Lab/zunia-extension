import { CONNECT_CONFIG } from "../config/connect";
import { PAGE_CHANNEL } from "../lib/messaging";
import type { ZuniaKey, ZuniaOfflineSigner, ZuniaProvider } from "../types/window";

type RpcRequest = {
  id: string;
  method: string;
  args: unknown[];
};

type RpcResponse = {
  id: string;
  result?: unknown;
  error?: string;
};

type EventHandler = (data: unknown) => void;

/**
 * MAIN-world provider. Talks only over a nonce-scoped MessageChannel
 * established with the content script (origin checked on both sides).
 */
export default defineUnlistedScript(() => {
  const script = document.currentScript as HTMLScriptElement | null;
  const nonce = script?.dataset.zuniaNonce;
  const expectedOrigin = script?.dataset.zuniaOrigin ?? window.location.origin;

  if (!nonce) {
    console.warn("[zunia] injected script missing nonce");
    return;
  }

  let port: MessagePort | null = null;
  let portReady: Promise<void>;
  const pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  const listeners = new Map<string, Set<EventHandler>>();

  function emit(event: string, data: unknown): void {
    const set = listeners.get(event);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(data);
      } catch (err) {
        console.error("[zunia] event handler error", err);
      }
    }
  }

  portReady = new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error("Zunia provider handshake timed out"));
    }, 5_000);

    const onMessage = (event: MessageEvent) => {
      if (event.source !== window) return;
      if (event.origin !== expectedOrigin) return;
      const data = event.data as { type?: string; nonce?: string } | null;
      if (!data || data.type !== PAGE_CHANNEL.handshakeAck) return;
      if (data.nonce !== nonce) return;
      if (!event.ports[0]) return;

      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      port = event.ports[0];
      port.onmessage = (portEvent: MessageEvent<RpcResponse & { type?: string; event?: string; data?: unknown }>) => {
        const msg = portEvent.data;
        if (msg?.type === PAGE_CHANNEL.event && msg.event) {
          if (msg.event === "accountsChanged") emit("keplr_keystorechange", msg.data);
          if (msg.event === "accountsChanged") emit("accountChanged", msg.data);
          if (msg.event === "chainChanged") emit("chainChanged", msg.data);
          if (msg.event === "settingsChanged") {
            applyKeplrAlias(
              Boolean(
                (msg.data as { exposeKeplrAlias?: boolean } | null)
                  ?.exposeKeplrAlias,
              ),
            );
          }
          return;
        }
        if (!msg?.id) return;
        const waiter = pending.get(msg.id);
        if (!waiter) return;
        pending.delete(msg.id);
        if (msg.error) waiter.reject(new Error(msg.error));
        else waiter.resolve(msg.result);
      };
      resolve();
    };

    window.addEventListener("message", onMessage);
    window.postMessage(
      { type: PAGE_CHANNEL.handshake, nonce },
      expectedOrigin,
    );
  });

  async function request(method: string, args: unknown[] = []): Promise<unknown> {
    await portReady;
    if (!port) throw new Error("Provider port not ready");
    const id = crypto.randomUUID();
    const payload: RpcRequest = { id, method, args };
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      port!.postMessage(payload);
    });
  }

  function on(event: string, handler: EventHandler): void {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event)!.add(handler);
  }

  function off(event: string, handler: EventHandler): void {
    listeners.get(event)?.delete(handler);
  }

  function getOfflineSigner(chainId: string): ZuniaOfflineSigner {
    return {
      getAccounts: async () => {
        const accounts = (await request("getAccounts", [chainId])) as Array<{
          address: string;
          algo: string;
          pubkey: number[];
        }>;
        return accounts.map((a) => ({
          address: a.address,
          algo: a.algo,
          pubkey: Uint8Array.from(a.pubkey),
        }));
      },
      signAmino: (signerAddress: string, signDoc: unknown) =>
        request("signAmino", [chainId, signerAddress, signDoc]),
      signDirect: (signerAddress: string, signDoc: unknown) =>
        request("signDirect", [chainId, signerAddress, signDoc]),
    };
  }

  const provider: ZuniaProvider & {
    sendTx: (
      chainId: string,
      tx: unknown,
      mode?: string,
    ) => Promise<unknown>;
    getAccounts: (chainId?: string) => Promise<unknown>;
    getChainInfos: () => Promise<unknown>;
    on: typeof on;
    off: typeof off;
  } = {
    version: CONNECT_CONFIG.provider.version,
    mode: "extension",
    defaultOptions: {},
    enable: async (chainIds) => {
      await request("enable", [chainIds]);
    },
    getKey: async (chainId) => {
      const key = (await request("getKey", [chainId])) as Omit<
        ZuniaKey,
        "pubKey"
      > & { pubKey: number[] };
      return {
        ...key,
        pubKey: Uint8Array.from(key.pubKey),
      };
    },
    getAccounts: async (chainId?: string) => request("getAccounts", [chainId]),
    getOfflineSigner,
    getOfflineSignerOnlyAmino: getOfflineSigner,
    getOfflineSignerAuto: async (chainId) => getOfflineSigner(chainId),
    signAmino: async (chainId, signer, signDoc) =>
      request("signAmino", [chainId, signer, signDoc]),
    signDirect: async (chainId, signer, signDoc) =>
      request("signDirect", [chainId, signer, signDoc]),
    sendTx: async (chainId, tx, mode) =>
      request("sendTx", [chainId, tx, mode]),
    experimentalSuggestChain: async (chainInfo) => {
      await request("experimentalSuggestChain", [chainInfo]);
    },
    getChainInfosWithoutEndpoints: async () =>
      (await request("getChainInfosWithoutEndpoints", [])) as unknown[],
    getChainInfos: async () =>
      (await request("getChainInfos", [])) as unknown[],
    on,
    off,
  };

  function applyKeplrAlias(enabled: boolean): void {
    if (enabled) {
      window.keplr = provider;
    } else if (window.keplr === provider) {
      delete window.keplr;
    }
  }

  window.zunia = provider;
  // Keplr alias is OFF by default; content script may enable via settings event.
  applyKeplrAlias(false);

  window.dispatchEvent(new Event("zunia#initialized"));
});
