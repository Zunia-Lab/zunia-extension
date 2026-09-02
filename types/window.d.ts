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

/** Cosmos-compatible wallet provider exposed to dApps */
export interface ZuniaProvider {
  readonly version: string;
  readonly mode: "extension";
  readonly defaultOptions?: Record<string, unknown>;
  enable(chainIds: string | string[]): Promise<void>;
  disable?(chainIds?: string | string[]): Promise<void>;
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
  ): Promise<unknown>;
  signDirect?(
    chainId: string,
    signer: string,
    signDoc: unknown,
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
  on?(event: string, handler: (data: unknown) => void): void;
  off?(event: string, handler: (data: unknown) => void): void;
}

declare global {
  interface Window {
    zunia?: ZuniaProvider;
    /** Optional Keplr-compatible alias when user opts in via settings. */
    keplr?: ZuniaProvider;
  }
}

export {};
