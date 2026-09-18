/**
 * Ambient types for `@zunialab/core`, the Rust wallet kernel compiled to WebAssembly.
 *
 * Kept in sync by hand with `zunia-core/packages/npm/index.d.ts`, which
 * `zunia-core/scripts/build-wasm.sh` generates. This file is what typechecks the dynamic
 * import in `lib/kernel.ts` while the package is resolved by a link rather than published;
 * an ambient declaration wins over node_modules, so it also stays authoritative afterwards.
 * If the two drift, `lib/kernel.ts` will compile against a surface the artifact does not
 * have and the failure lands at runtime as an undefined function inside the signer.
 */
declare module "@zunialab/core" {
  /** An integer that reaches the wasm boundary as u64. The facade coerces to BigInt. */
  export type U64Like = bigint | number | string;

  export type SignMode = "direct" | "amino";

  export interface Coin {
    denom: string;
    amount: string;
  }

  /** One entry of `msgsJson`. `value` is proto-JSON: snake_case keys, amounts as strings. */
  export interface BuiltMsg {
    typeUrl: string;
    value: Record<string, unknown>;
  }

  /** `feeJson`. `gas_limit` is a string because a JSON number cannot hold a full u64. */
  export interface FeeJson {
    amount: Coin[];
    gas_limit: string;
  }

  export interface InitInput {
    module_or_path?: RequestInfo | URL | Response | BufferSource | WebAssembly.Module;
  }

  /**
   * Instantiates the module. Nothing else in this package works until it resolves, because
   * the artifact is built for the wasm-bindgen `web` target and nothing is instantiated at
   * import time.
   */
  export function initZuniaCore(
    input?: InitInput | RequestInfo | URL | Response | BufferSource | WebAssembly.Module,
  ): Promise<unknown>;

  export function initZuniaCoreSync(
    input: InitInput | BufferSource | WebAssembly.Module,
  ): unknown;

  export interface DerivedAddress {
    address: string;
    publicKeyHex: string;
    path: string;
    /** Present only for chains that derive an Ethereum-style address. */
    ethAddress?: string;
  }

  export interface DecodedDirectTx {
    chainId: string;
    memo: string;
    hasUnknownMsgs: boolean;
    safeWithoutBlindSigning: boolean;
    summaries: string[];
    addresses: string[];
  }

  /** What `previewTx` returns: enough to render an approval screen without signing. */
  export interface SigningPreview {
    chainId: string;
    mode: SignMode;
    messages: Array<{ typeUrl: string; summary: string; spendsFunds: boolean }>;
    summaries: string[];
    fee: Coin[];
    /** String: a u64 does not survive a JSON number. */
    gasLimit: string;
    memo: string;
    spendsFunds: boolean;
    counterparties: string[];
    /** SHA-256 of the sign bytes, hex. Lets a user confirm prompt and broadcast match. */
    signBytesHash: string;
  }

  export function kernelVersion(): string;
  export function generateMnemonic(words: number): string;
  export function validateMnemonic(phrase: string): boolean;
  export function sealKeyring(
    phrase: string,
    password: string,
    metadataJson: string,
  ): string;
  export function openKeyring(envelopeJson: string, password: string): string;
  export function rotateKeyringPassword(
    envelopeJson: string,
    oldPassword: string,
    newPassword: string,
  ): string;
  export function deriveAddress(
    phrase: string,
    passphrase: string,
    chainJson: string,
    accountIndex: number,
  ): DerivedAddress;
  export function signCosmos(
    phrase: string,
    passphrase: string,
    chainJson: string,
    accountIndex: number,
    signBytesHex: string,
  ): string;
  export function decodeDirectTx(signDocHex: string): DecodedDirectTx;
  export function personalSign(
    phrase: string,
    passphrase: string,
    accountIndex: number,
    message: string,
  ): string;
  export function signTypedData(
    phrase: string,
    passphrase: string,
    accountIndex: number,
    typedDataJson: string,
  ): string;
  export function signEvmTx(
    phrase: string,
    passphrase: string,
    accountIndex: number,
    txJson: string,
  ): unknown;
  export function validateBech32Address(
    address: string,
    expectedPrefix: string,
  ): boolean;
  export function parseChain(chainJson: string): unknown;

  /**
   * @deprecated Only expresses a bank send. Use {@link buildSignBytes}, the only path that
   * can also express staking, governance, IBC and contract calls.
   */
  export function buildBankSendDirect(
    chainId: string,
    from: string,
    to: string,
    amount: string,
    denom: string,
    memo: string,
    accountNumber: U64Like,
    sequence: U64Like,
    feeAmount: string,
    feeDenom: string,
    gasLimit: U64Like,
    publicKeyHex: string,
    ethKeyType: boolean,
  ): string;

  /** The bytes the kernel must sign, hex. Pure: no key material crosses this call. */
  export function buildSignBytes(
    chainId: string,
    msgsJson: string,
    feeJson: string,
    memo: string,
    accountNumber: U64Like,
    sequence: U64Like,
    publicKeyHex: string,
    ethKeyType: boolean,
    mode: SignMode,
  ): string;

  /** The broadcastable `TxRaw`, hex, given a signature over {@link buildSignBytes}. */
  export function assembleTxRaw(
    chainId: string,
    msgsJson: string,
    feeJson: string,
    memo: string,
    accountNumber: U64Like,
    sequence: U64Like,
    publicKeyHex: string,
    ethKeyType: boolean,
    mode: SignMode,
    signatureHex: string,
  ): string;

  /** A `TxRaw` carrying a 64-byte zero signature, for `/cosmos/tx/v1beta1/simulate`. */
  export function buildSimulateTx(
    chainId: string,
    msgsJson: string,
    feeJson: string,
    memo: string,
    accountNumber: U64Like,
    sequence: U64Like,
    publicKeyHex: string,
    ethKeyType: boolean,
  ): string;

  /** derive -> sign bytes -> sign -> assemble, in one call. Returns a hex `TxRaw`. */
  export function signTx(
    phrase: string,
    passphrase: string,
    chainJson: string,
    accountIndex: number,
    chainId: string,
    msgsJson: string,
    feeJson: string,
    memo: string,
    accountNumber: U64Like,
    sequence: U64Like,
    mode: SignMode,
  ): string;

  /** What will be signed, without signing it. Pure: no key material crosses this call. */
  export function previewTx(
    chainId: string,
    msgsJson: string,
    feeJson: string,
    memo: string,
    accountNumber: U64Like,
    sequence: U64Like,
    publicKeyHex: string,
    ethKeyType: boolean,
    mode: SignMode,
  ): SigningPreview;
}
