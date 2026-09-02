/**
 * Secure dApp / WalletConnect connection config for the browser extension.
 */

export const CONNECT_CONFIG = {
  schemaVersion: 1,

  provider: {
    /** Primary in-page API: window.zunia */
    globalName: "zunia" as const,
    /** Optional Keplr-compatible alias for existing dApps */
    keplrCompatibleAlias: "keplr" as const,
    /** Default OFF — user opts in via chrome.storage.local settings. */
    exposeKeplrAlias: false,
    version: "0.1.0",
    isZunia: true,
  },

  wallet: {
    name: "Zunia",
    shortName: "Zunia",
    url: "https://zuniawallet.com",
    icons: [
      "https://raw.githubusercontent.com/Zunia-Lab/zunia-brand/main/png/icons/app/zunia-icon-512.png",
    ],
  },

  /** Origins that may message the extension via chrome.runtime (dashboard / site). */
  externallyConnectableMatches: [
    "https://zuniawallet.com/*",
    "https://*.zuniawallet.com/*",
    "https://docs.zuniawallet.com/*",
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
    /** Per-origin permission before enable() / getAccounts */
    defaultOriginPolicy: "prompt" as const,
    requireUserApproval: true,
    requireTxPreview: true,
    /** Do not auto-approve known phishing domains (list filled later) */
    blocklistEnabled: true,
    /** Isolate provider in MAIN world via separate injected script */
    injectInMainWorld: true,
  },

  walletConnect: {
    version: 2,
    /** Same Cloud project as mobile / dashboard */
    projectIdEnv: "WXT_WALLETCONNECT_PROJECT_ID",
    relayUrl: "wss://relay.walletconnect.com",
    /** Mobile deep link when extension opens WC pairing on phone */
    mobileDeepLink: "zunia://wc",
    universalLink: "https://zuniawallet.com/wc",
  },

  cosmosMethods: [
    "enable",
    "getKey",
    "getOfflineSigner",
    "getOfflineSignerOnlyAmino",
    "getOfflineSignerAuto",
    "signAmino",
    "signDirect",
    "signArbitrary",
    "verifyArbitrary",
    "experimentalSuggestChain",
    "getChainInfosWithoutEndpoints",
  ],
} as const;

export type ConnectConfig = typeof CONNECT_CONFIG;
