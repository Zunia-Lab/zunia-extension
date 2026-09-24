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
  code?: string;
};

/** What a failed call rejects with: the wallet's message and a stable `code`. */
class ZuniaProviderError extends Error {
  readonly code: string;

  constructor(message: string, code: string | undefined) {
    super(message);
    this.name = "ZuniaProviderError";
    this.code = code ?? "INTERNAL";
  }
}

type EventHandler = (data: unknown) => void;

type DirectSignDocInput = {
  bodyBytes?: unknown;
  authInfoBytes?: unknown;
  chainId?: unknown;
  accountNumber?: unknown;
};

/** Typed arrays do not survive runtime messaging as arrays; plain arrays do. */
function wireBytes(value: unknown): unknown {
  return value instanceof Uint8Array ? Array.from(value) : value;
}

/**
 * The extension hop JSON-serializes every message, which turns a Uint8Array into
 * an index-keyed object and throws on a bigint. Send plain arrays and a decimal
 * string instead; the background re-encodes the exact SignDoc bytes from them.
 */
function wireDirectSignDoc(signDoc: unknown): unknown {
  if (!signDoc || typeof signDoc !== "object") return signDoc;
  const doc = signDoc as DirectSignDocInput;
  const accountNumber = doc.accountNumber;
  return {
    bodyBytes: wireBytes(doc.bodyBytes),
    authInfoBytes: wireBytes(doc.authInfoBytes),
    chainId: doc.chainId,
    accountNumber:
      accountNumber === undefined || accountNumber === null
        ? "0"
        : typeof accountNumber === "object"
          ? String((accountNumber as { toString(): string }).toString())
          : String(accountNumber),
  };
}

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
  const pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: ZuniaProviderError) => void }
  >();
  const listeners = new Map<string, Set<EventHandler>>();
  let keplrAliasOn = false;

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

  /** dApps written for Keplr listen on window, not on the provider object. */
  function dispatchWindowEvent(name: string): void {
    window.dispatchEvent(new Event(`zunia_${name}`));
    if (keplrAliasOn) window.dispatchEvent(new Event(`keplr_${name}`));
  }

  const portReady = new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new ZuniaProviderError("Zunia provider handshake timed out", "INTERNAL"));
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
          if (msg.event === "accountsChanged") {
            emit("accountsChanged", msg.data);
            emit("keplr_keystorechange", msg.data);
            emit("accountChanged", msg.data);
            dispatchWindowEvent("keystorechange");
          }
          if (msg.event === "disconnect") {
            emit("disconnect", msg.data);
            // Losing some chains is a key change for a Keplr-style dApp, which
            // then finds out which getKey calls stopped working.
            const partial = Array.isArray((msg.data as { chainIds?: unknown } | null)?.chainIds);
            dispatchWindowEvent(partial ? "keystorechange" : "disconnect");
          }
          if (msg.event === "locked") {
            emit("locked", msg.data);
            window.dispatchEvent(new Event("zunia_locked"));
          }
          if (msg.event === "chainChanged") {
            emit("chainChanged", msg.data);
            window.dispatchEvent(new CustomEvent("zunia_chainchanged", { detail: msg.data }));
          }
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
        if (msg.error) waiter.reject(new ZuniaProviderError(msg.error, msg.code));
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
    if (!port) throw new ZuniaProviderError("Provider port not ready", "INTERNAL");
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

  /**
   * Keplr's sign options: the call's own first, then `defaultOptions.sign`,
   * which dApps set on the provider. Only `preferNoSetFee` changes anything.
   */
  function signOptionsFor(explicit: unknown): { preferNoSetFee: boolean } {
    const defaults = (provider.defaultOptions as { sign?: { preferNoSetFee?: unknown } } | undefined)
      ?.sign;
    const given = explicit && typeof explicit === "object" ? (explicit as { preferNoSetFee?: unknown }) : {};
    return { preferNoSetFee: (given.preferNoSetFee ?? defaults?.preferNoSetFee) === true };
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
        request("signAmino", [chainId, signerAddress, signDoc, signOptionsFor(undefined)]),
      signDirect: (signerAddress: string, signDoc: unknown) =>
        signDirect(chainId, signerAddress, signDoc),
    };
  }

  /** No signDirect: CosmJS picks direct signing whenever a signer offers it. */
  function getOfflineSignerOnlyAmino(chainId: string): ZuniaOfflineSigner {
    const { getAccounts, signAmino } = getOfflineSigner(chainId);
    return { getAccounts, signAmino };
  }

  async function signDirect(
    chainId: string,
    signer: string,
    signDoc: unknown,
    signOptions?: unknown,
  ) {
    const response = (await request("signDirect", [
      chainId,
      signer,
      wireDirectSignDoc(signDoc),
      signOptionsFor(signOptions),
    ])) as {
      signature: unknown;
      feeChanged?: boolean;
      signed?: { authInfoBytes?: unknown };
    };
    // The background signed exactly the bytes of this document, so hand the
    // caller's own object back rather than the JSON copy. When the user picked
    // another fee tier only the auth info changed, and the caller needs it to
    // broadcast what was signed.
    const authInfoBytes = response.signed?.authInfoBytes;
    if (response.feeChanged === true && Array.isArray(authInfoBytes) && signDoc && typeof signDoc === "object") {
      return {
        signed: { ...signDoc, authInfoBytes: Uint8Array.from(authInfoBytes as number[]) },
        signature: response.signature,
      };
    }
    return { signed: signDoc, signature: response.signature };
  }

  const provider: ZuniaProvider & {
    sendTx: (
      chainId: string,
      tx: unknown,
      mode?: string,
    ) => Promise<unknown>;
    getAccounts: (chainId?: string) => Promise<unknown>;
    getChainInfos: () => Promise<unknown>;
    getConnectedChains: () => Promise<string[]>;
    isLocked: () => Promise<boolean>;
    on: typeof on;
    off: typeof off;
  } = {
    version: CONNECT_CONFIG.provider.version,
    mode: "extension",
    defaultOptions: {},
    enable: async (chainIds) => {
      await request("enable", [chainIds]);
    },
    getConnectedChains: async () => (await request("getConnectedChains", [])) as string[],
    isLocked: async () => (await request("isLocked", [])) as boolean,
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
    getOfflineSignerOnlyAmino,
    getOfflineSignerAuto: async (chainId) => getOfflineSigner(chainId),
    signAmino: async (chainId, signer, signDoc, signOptions?: unknown) =>
      request("signAmino", [chainId, signer, signDoc, signOptionsFor(signOptions)]),
    signDirect: async (chainId, signer, signDoc, signOptions?: unknown) =>
      signDirect(chainId, signer, signDoc, signOptions),
    signArbitrary: async (chainId, signer, data) =>
      request("signArbitrary", [chainId, signer, wireBytes(data)]),
    verifyArbitrary: async (...args: unknown[]) =>
      (await request(
        "verifyArbitrary",
        args.map((arg, i) => (i === 2 ? wireBytes(arg) : arg)),
      )) as boolean,
    disable: async (chainIds?) => {
      await request("disable", chainIds === undefined ? [] : [chainIds]);
    },
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
    keplrAliasOn = enabled;
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
