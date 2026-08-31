/**
 * In-page provider type surface (window.zunia).
 * Implementation TBD — types reserved for secure dApp integration.
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
  signAmino?(...args: unknown[]): Promise<unknown>;
  signDirect?(...args: unknown[]): Promise<unknown>;
}

/** Cosmos-compatible wallet provider exposed to dApps */
export interface ZuniaProvider {
  readonly version: string;
  readonly mode: "extension";
  readonly defaultOptions?: Record<string, unknown>;
  enable(chainIds: string | string[]): Promise<void>;
  disable?(chainIds?: string | string[]): Promise<void>;
  getKey(chainId: string): Promise<ZuniaKey>;
  getOfflineSigner(chainId: string): ZuniaOfflineSigner;
  getOfflineSignerOnlyAmino?(chainId: string): ZuniaOfflineSigner;
  getOfflineSignerAuto?(
    chainId: string,
  ): Promise<ZuniaOfflineSigner>;
  experimentalSuggestChain?(chainInfo: unknown): Promise<void>;
  getChainInfosWithoutEndpoints?(): Promise<unknown[]>;
  signAmino?(...args: unknown[]): Promise<unknown>;
  signDirect?(...args: unknown[]): Promise<unknown>;
  signArbitrary?(
    chainId: string,
    signer: string,
    data: string | Uint8Array,
  ): Promise<unknown>;
  verifyArbitrary?(...args: unknown[]): Promise<boolean>;
}

declare global {
  interface Window {
    zunia?: ZuniaProvider;
    /** Optional Keplr-compatible alias when CONNECT_CONFIG.exposeKeplrAlias is true */
    keplr?: ZuniaProvider;
  }
}

export {};
