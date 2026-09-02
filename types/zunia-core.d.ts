/**
 * Ambient types for the published WASM package.
 * Until `@zunialab/core` is on npm, runtime falls back to the mock in lib/kernel.ts.
 */
declare module "@zunialab/core" {
  export function kernelVersion(): string;
  export function generateMnemonic(words: number): string;
  export function validateMnemonic(phrase: string): boolean;
  export function sealKeyring(
    phrase: string,
    password: string,
    metadataJson: string,
  ): string;
  export function openKeyring(envelopeJson: string, password: string): string;
  export function deriveAddress(
    phrase: string,
    passphrase: string,
    chainJson: string,
    accountIndex: number,
  ): unknown;
  export function signCosmos(
    phrase: string,
    passphrase: string,
    chainJson: string,
    accountIndex: number,
    signBytesHex: string,
  ): string;
  export function decodeDirectTx(signDocHex: string): unknown;
}
