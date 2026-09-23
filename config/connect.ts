/**
 * dApp connection surface of the browser extension: the in-page provider, who
 * may message the extension, and where the provider is injected.
 */

export const CONNECT_CONFIG = {
  schemaVersion: 2,

  provider: {
    /** Primary in-page API: window.zunia */
    globalName: "zunia" as const,
    /** Optional Keplr-compatible alias for existing dApps */
    keplrCompatibleAlias: "keplr" as const,
    /** Default OFF. The user opts in from Settings > Security. */
    exposeKeplrAlias: false,
    version: "0.1.0",
    isZunia: true,
  },

  wallet: {
    name: "Zunia",
    shortName: "Zunia",
    url: "https://zunialab.com",
    icons: [
      "https://raw.githubusercontent.com/Zunia-Lab/zunia-brand/main/png/icons/app/zunia-icon-512.png",
    ],
  },

  /**
   * Origins that may message the extension via chrome.runtime. They get PING
   * and a lock status without accounts, nothing else.
   */
  externallyConnectableMatches: [
    "https://zunialab.com/*",
    "https://*.zunialab.com/*",
    "https://docs.zunialab.com/*",
    "http://localhost/*",
    "http://127.0.0.1/*",
  ],

  /**
   * Pages where the content script may inject the provider.
   * Prefer https; http limited to localhost for local dApp dev.
   */
  contentScriptMatches: [
    "https://*/*",
    "http://localhost/*",
    "http://127.0.0.1/*",
    "http://[::1]/*",
  ],

  security: {
    /** Per-origin, per-chain approval before enable(), getKey, or getAccounts */
    defaultOriginPolicy: "prompt" as const,
    requireUserApproval: true,
    /** Every signature request opens a decoded preview in the extension popup */
    requireTxPreview: true,
    /** Provider runs in the MAIN world, keys stay in the service worker */
    injectInMainWorld: true,
  },

  /** Methods window.zunia implements. sendTx exists and always refuses. */
  cosmosMethods: [
    "enable",
    "disable",
    "getKey",
    "getAccounts",
    "getOfflineSigner",
    "getOfflineSignerOnlyAmino",
    "getOfflineSignerAuto",
    "signAmino",
    "signDirect",
    "signArbitrary",
    "verifyArbitrary",
    "experimentalSuggestChain",
    "getChainInfos",
    "getChainInfosWithoutEndpoints",
  ],
} as const;

export type ConnectConfig = typeof CONNECT_CONFIG;
