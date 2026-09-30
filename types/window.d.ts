/**
 * In-page provider type surface (window.zunia).
 */

export interface ZuniaKey {
  name: string;
  algo: string;
  pubKey: Uint8Array;
  address: string;
  bech32Address: string;
  isNanoLedger?: boolean;
  isKeystone?: boolean;
  /**
   * Same 20-byte account as `bech32Address`, EIP-55 hex. Present only on
   * chains that derive an Ethereum-style address.
   */
  ethereumHexAddress?: string;
}

export interface ZuniaOfflineSigner {
  getAccounts(): Promise<
    Array<{
      address: string;
      algo: string;
      pubkey: Uint8Array;
    }>
  >;
  signAmino?(
    signerAddress: string,
    signDoc: unknown,
  ): Promise<unknown>;
  signDirect?(
    signerAddress: string,
    signDoc: unknown,
  ): Promise<unknown>;
}

export type ZuniaProviderErrorCode =
  | "USER_REJECTED"
  | "NOT_CONNECTED"
  | "LOCKED"
  | "UNKNOWN_CHAIN"
  | "ORIGIN_MISMATCH"
  | "UNSUPPORTED"
  | "INVALID_PARAMS"
  | "INTERNAL";

/** What every failed provider call rejects with. */
export interface ZuniaProviderError extends Error {
  readonly name: "ZuniaProviderError";
  readonly code: ZuniaProviderErrorCode;
}

/**
 * Events on `provider.on(...)`, delivered only to sites with a live grant:
 * - accountsChanged: the active account changed or the wallet unlocked; call getKey again.
 * - chainChanged: `{ chainIds }`, every chain the site may use now.
 * - disconnect: `{ chainIds }` for the chains lost, or null when the grant ended.
 * - locked: the wallet locked.
 */
export type ZuniaProviderEvent = "accountsChanged" | "chainChanged" | "disconnect" | "locked";

/** Cosmos-compatible wallet provider exposed to dApps */
export interface ZuniaProvider {
  readonly version: string;
  readonly mode: "extension";
  readonly defaultOptions?: Record<string, unknown>;
  enable(chainIds: string | string[]): Promise<void>;
  disable?(chainIds?: string | string[]): Promise<void>;
  /** Chains this site is connected to. Never opens a window; [] when not connected. */
  getConnectedChains?(): Promise<string[]>;
  /** Whether the wallet is locked. Connected sites only. */
  isLocked?(): Promise<boolean>;
  getKey(chainId: string): Promise<ZuniaKey>;
  getAccounts?(chainId?: string): Promise<unknown>;
  getOfflineSigner(chainId: string): ZuniaOfflineSigner;
  getOfflineSignerOnlyAmino?(chainId: string): ZuniaOfflineSigner;
  getOfflineSignerAuto?(
    chainId: string,
  ): Promise<ZuniaOfflineSigner>;
  experimentalSuggestChain?(chainInfo: unknown): Promise<void>;
  getChainInfosWithoutEndpoints?(): Promise<unknown[]>;
  getChainInfos?(): Promise<unknown[]>;
  signAmino?(
    chainId: string,
    signer: string,
    signDoc: unknown,
    signOptions?: { preferNoSetFee?: boolean; preferNoSetMemo?: boolean },
  ): Promise<unknown>;
  signDirect?(
    chainId: string,
    signer: string,
    signDoc: unknown,
    signOptions?: { preferNoSetFee?: boolean; preferNoSetMemo?: boolean },
  ): Promise<unknown>;
  sendTx?(
    chainId: string,
    tx: unknown,
    mode?: string,
  ): Promise<unknown>;
  signArbitrary?(
    chainId: string,
    signer: string,
    data: string | Uint8Array,
  ): Promise<unknown>;
  verifyArbitrary?(...args: unknown[]): Promise<boolean>;
  on?(event: ZuniaProviderEvent | (string & {}), handler: (data: unknown) => void): void;
  off?(event: ZuniaProviderEvent | (string & {}), handler: (data: unknown) => void): void;
}

declare global {
  interface Window {
    zunia?: ZuniaProvider;
    /** Optional Keplr-compatible alias when user opts in via settings. */
    keplr?: ZuniaProvider;
  }
}

export {};
