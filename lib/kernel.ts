/**
 * Local signing kernel.
 *
 * Runs real BIP-39 / BIP-32 / secp256k1 derivation and scrypt +
 * XChaCha20-Poly1305 keyring sealing entirely inside the background worker,
 * using audited primitives from @noble and @scure. `@zunialab/core` (the Rust
 * WASM kernel) is preferred when installed; this module is the JS equivalent
 * and the shipping default until that package is published.
 */

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { scrypt } from "@noble/hashes/scrypt.js";
import { bech32 } from "@scure/base";
import { HDKey } from "@scure/bip32";
import {
  generateMnemonic,
  mnemonicToSeedSync,
  validateMnemonic,
} from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

export interface DerivedAddress {
  address: string;
  bech32Address: string;
  algo: string;
  pubKey: Uint8Array;
  path?: string;
}

export interface DecodedTxMessage {
  typeUrl: string;
  summary: string;
  unknown?: boolean;
  recipient?: string;
}

export interface DecodedDirectTx {
  chainId: string;
  accountNumber: string;
  messages: DecodedTxMessage[];
  memo?: string;
  fee?: { amount: string; denom: string; gas: string };
}

export interface ZuniaKernel {
  kernelVersion(): string;
  generateMnemonic(words: number): string;
  validateMnemonic(phrase: string): boolean;
  sealKeyring(phrase: string, password: string, metadataJson: string): string;
  openKeyring(envelopeJson: string, password: string): string;
  deriveAddress(
    phrase: string,
    passphrase: string,
    chainJson: string,
    accountIndex: number,
  ): DerivedAddress;
  signCosmos(
    phrase: string,
    passphrase: string,
    chainJson: string,
    accountIndex: number,
    signBytesHex: string,
  ): string;
  decodeDirectTx(signDocHex: string): DecodedDirectTx;
}

/**
 * scrypt work factor. N=2^15 with p=4 keeps peak memory near 32 MB so the MV3
 * service worker survives, while costing ~250 ms per unlock on a laptop.
 */
const KDF = { N: 2 ** 15, r: 8, p: 4, dkLen: 32 } as const;
const ENVELOPE_VERSION = 2;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function sha256Hex(input: string): Promise<string> {
  return bytesToHex(sha256(utf8Bytes(input)));
}

interface ChainSpec {
  bech32Prefix: string;
  coinType: number;
  /** Ethermint chains take the keccak tail of the uncompressed key. */
  ethermint: boolean;
}

function parseChain(chainJson: string): ChainSpec {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(chainJson) as Record<string, unknown>;
  } catch {
    // Fall through to Cosmos Hub defaults.
  }
  const bip44 = raw.bip44 as { coinType?: number } | undefined;
  const coinType =
    (typeof raw.coinType === "number" ? raw.coinType : undefined) ??
    bip44?.coinType ??
    118;
  return {
    bech32Prefix:
      typeof raw.bech32Prefix === "string" ? raw.bech32Prefix : "cosmos",
    coinType,
    ethermint: raw.addressScheme === "ethermint" || coinType === 60,
  };
}

function normalizePhrase(phrase: string): string {
  return phrase.trim().replace(/\s+/g, " ").toLowerCase();
}

function derivePrivateKey(
  phrase: string,
  passphrase: string,
  chain: ChainSpec,
  accountIndex: number,
): { privateKey: Uint8Array; path: string } {
  const seed = mnemonicToSeedSync(normalizePhrase(phrase), passphrase);
  const path = `m/44'/${chain.coinType}'/0'/0/${accountIndex}`;
  const node = HDKey.fromMasterSeed(seed).derive(path);
  if (!node.privateKey) {
    throw new Error("Derivation produced no private key");
  }
  return { privateKey: node.privateKey, path };
}

function addressBytes(pubKey: Uint8Array, ethermint: boolean): Uint8Array {
  if (ethermint) {
    const uncompressed = secp256k1.getPublicKey(pubKey, false);
    return keccak_256(uncompressed.slice(1)).slice(-20);
  }
  return ripemd160(sha256(pubKey));
}

/**
 * Real kernel: every operation below is standards-compliant crypto. Addresses
 * match the Rust kernel vectors (all-`abandon` mnemonic, m/44'/118'/0'/0/0 →
 * cosmos19rl4cm2hmr8afy4kldpxz3fka4jguq0auqdal4).
 */
export function createLocalKernel(): ZuniaKernel {
  return {
    kernelVersion: () => "js-1.0.0",

    generateMnemonic: (words) =>
      generateMnemonic(wordlist, words === 24 ? 256 : 128),

    validateMnemonic: (phrase) => {
      try {
        return validateMnemonic(normalizePhrase(phrase), wordlist);
      } catch {
        return false;
      }
    },

    sealKeyring: (phrase, password, metadataJson) => {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const nonce = crypto.getRandomValues(new Uint8Array(24));
      const key = scrypt(utf8Bytes(password.normalize("NFKC")), salt, KDF);
      const aad = utf8Bytes(metadataJson);
      const cipher = xchacha20poly1305(key, nonce, aad).encrypt(
        utf8Bytes(phrase),
      );
      key.fill(0);
      return JSON.stringify({
        v: ENVELOPE_VERSION,
        kdf: { name: "scrypt", ...KDF, salt: toBase64(salt) },
        cipher: { name: "xchacha20poly1305", nonce: toBase64(nonce) },
        data: toBase64(cipher),
        metadata: metadataJson,
      });
    },

    openKeyring: (envelopeJson, password) => {
      const envelope = JSON.parse(envelopeJson) as {
        v?: number;
        kdf?: { N: number; r: number; p: number; dkLen: number; salt: string };
        cipher?: { nonce: string };
        data?: string;
        metadata?: string;
      };
      if (envelope.v !== ENVELOPE_VERSION || !envelope.kdf || !envelope.data) {
        throw new Error(
          "This wallet was sealed by an older build. Restore it from your recovery phrase.",
        );
      }
      const { salt, ...work } = envelope.kdf;
      const key = scrypt(
        utf8Bytes(password.normalize("NFKC")),
        fromBase64(salt),
        work,
      );
      const aad = utf8Bytes(envelope.metadata ?? "");
      try {
        const plain = xchacha20poly1305(
          key,
          fromBase64(envelope.cipher?.nonce ?? ""),
          aad,
        ).decrypt(fromBase64(envelope.data));
        return new TextDecoder().decode(plain);
      } catch {
        throw new Error("Invalid password");
      } finally {
        key.fill(0);
      }
    },

    deriveAddress: (phrase, passphrase, chainJson, accountIndex) => {
      const chain = parseChain(chainJson);
      const { privateKey, path } = derivePrivateKey(
        phrase,
        passphrase,
        chain,
        accountIndex,
      );
      const pubKey = secp256k1.getPublicKey(privateKey, true);
      privateKey.fill(0);
      const address = bech32.encode(
        chain.bech32Prefix,
        bech32.toWords(addressBytes(pubKey, chain.ethermint)),
      );
      return {
        address,
        bech32Address: address,
        algo: chain.ethermint ? "eth_secp256k1" : "secp256k1",
        pubKey,
        path,
      };
    },

    signCosmos: (
      phrase,
      passphrase,
      chainJson,
      accountIndex,
      signBytesHex,
    ) => {
      const chain = parseChain(chainJson);
      const { privateKey } = derivePrivateKey(
        phrase,
        passphrase,
        chain,
        accountIndex,
      );
      const payload = hexToBytes(signBytesHex);
      const digest = chain.ethermint
        ? keccak_256(payload)
        : sha256(payload);
      const signature = secp256k1.sign(digest, privateKey, {
        prehash: false,
        format: "compact",
      });
      privateKey.fill(0);
      return bytesToHex(signature);
    },

    decodeDirectTx: (signDocHex) => {
      try {
        const raw = new TextDecoder().decode(hexToBytes(signDocHex));
        const parsed = JSON.parse(raw) as Partial<DecodedDirectTx>;
        return {
          chainId: parsed.chainId ?? "unknown",
          accountNumber: parsed.accountNumber ?? "0",
          messages: parsed.messages ?? [
            {
              typeUrl: "/unknown.Msg",
              summary: "Unable to decode message body",
              unknown: true,
            },
          ],
          memo: parsed.memo,
          fee: parsed.fee,
        };
      } catch {
        return {
          chainId: "unknown",
          accountNumber: "0",
          messages: [
            {
              typeUrl: "/unknown.Msg",
              summary: "Blind / undecoded sign doc",
              unknown: true,
            },
          ],
        };
      }
    },
  };
}

let kernelPromise: Promise<ZuniaKernel> | null = null;

export function loadKernel(): Promise<ZuniaKernel> {
  if (!kernelPromise) {
    kernelPromise = (async () => {
      try {
        const mod = (await import(
          /* @vite-ignore */ "@zunialab/core"
        )) as Partial<ZuniaKernel> & Record<string, unknown>;
        if (
          typeof mod.generateMnemonic === "function" &&
          typeof mod.sealKeyring === "function" &&
          typeof mod.openKeyring === "function"
        ) {
          return mod as unknown as ZuniaKernel;
        }
      } catch {
        // WASM kernel not installed — the JS kernel below is equivalent.
      }
      return createLocalKernel();
    })();
  }
  return kernelPromise;
}

/** Test helper: force the in-process JS kernel. */
export function resetKernelForTests(): void {
  kernelPromise = Promise.resolve(createLocalKernel());
}

export { sha256Hex, bytesToHex, hexToBytes };
