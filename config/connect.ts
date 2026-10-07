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
    /**
     * Provider API version, "0.1.0" in every release: sites compare against it, so it
     * does not follow the release. The release is window.zunia.extensionVersion.
     */
    version: "0.1.0",
    isZunia: true,
    /**
     * window.zunia.features (from 0.1.5, lib/provider-identity.ts): what this build signs
     * that 0.1.4 and older refused or signed wrongly. Sites and @zunialab/sdk-core match
     * these exact strings, so never rename one; add a new string instead.
     * - sign-direct:wasm-contract-32: direct contract calls on 32-byte contract addresses
     *   (Osmosis's cross-chain swap contract, NFT collections) are read and prompted.
     * - sign-direct:send-32: a direct MsgSend to a 32-byte address is read and prompted.
     * - sign-direct:osmosis-poolmanager: Osmosis poolmanager swaps that sell an exact
     *   amount, single and split routes (since 0.1.4).
     * - sign-direct:osmosis-exact-out: poolmanager swaps that buy an exact amount.
     * - sign-amino:escaped: Amino sign bytes escape &, <, >, U+2028 and U+2029 the way
     *   chains rebuild them.
     * - sign-amino:osmosis-poolmanager: Amino poolmanager swap requests are described and
     *   prompted instead of refused.
     */
    features: [
      "sign-direct:wasm-contract-32",
      "sign-direct:send-32",
      "sign-direct:osmosis-poolmanager",
      "sign-direct:osmosis-exact-out",
      "sign-amino:escaped",
      "sign-amino:osmosis-poolmanager",
    ],
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
    "getConnectedChains",
    "isLocked",
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
