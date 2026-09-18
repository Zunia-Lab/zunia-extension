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

/** Version reported by the JS kernel. Distinct from the WASM kernel's crate version. */
const JS_KERNEL_VERSION = "js-1.0.0";

/** Which implementation {@link loadKernel} resolved to. */
export type KernelFlavor = "wasm" | "js";

/**
 * What the active kernel can actually do, so the UI can say so rather than guess.
 *
 * `canSignTransactions` is the one that matters. The JS kernel derives addresses and seals
 * keyrings correctly, but it has no Cosmos transaction encoder at all: it cannot turn a
 * message set into the bytes a chain will accept. A wallet that quietly signs something
 * plausible instead produces a signature that verifies against nothing, which surfaces on
 * chain as an opaque "unauthorized" long after the user approved it.
 */
export interface KernelStatus {
  flavor: KernelFlavor;
  /** `kernelVersion()` of the active implementation. */
  version: string;
  /** True only when the WASM kernel is loaded and its transaction surface is complete. */
  canSignTransactions: boolean;
  /**
   * Why the WASM kernel is not active, in a form fit to show a user. Present only when
   * `flavor` is `"js"`.
   */
  degradedReason?: string;
}

/**
 * Thrown when a transaction method is called on a kernel that cannot implement it.
 *
 * The JS fallback throws this rather than returning bytes. Returning something
 * plausible-looking is worse than failing: the caller would broadcast it, the chain would
 * reject the signature, and the user would be told nothing useful. Callers should surface
 * `message` and treat the wallet as read-only until the WASM kernel loads.
 */
export class KernelUnavailableError extends Error {
  /** Stable, matchable identifier. Message text is for humans and may change. */
  readonly code = "KERNEL_TRANSACTION_UNSUPPORTED" as const;
  readonly method: string;
  readonly kernel: KernelFlavor;

  constructor(method: string, kernel: KernelFlavor, reason?: string) {
    super(
      `${method} needs the @zunialab/core WASM kernel, which is not loaded${
        reason ? ` (${reason})` : ""
      }. The JavaScript fallback cannot build Cosmos transactions, and signing anything it produced would fail on chain.`,
    );
    this.name = "KernelUnavailableError";
    this.method = method;
    this.kernel = kernel;
  }
}

/** An integer that reaches the wasm boundary as u64. The facade coerces to BigInt. */
export type U64Like = bigint | number | string;

export type SignMode = "direct" | "amino";

export interface KernelCoin {
  denom: string;
  amount: string;
}

/**
 * One entry of `msgsJson`, in the shape `@zunialab/interchain` already emits.
 * `value` is proto-JSON: snake_case keys, amounts as decimal strings.
 *
 * `/cosmwasm.wasm.v1.MsgExecuteContract` is the trap: `value.msg` is a base64 string of the
 * contract JSON, not the object. The kernel decodes it on the way in.
 */
export interface KernelBuiltMsg {
  typeUrl: string;
  value: Record<string, unknown>;
}

/** `feeJson`. `gas_limit` is a string because a JSON number cannot hold a full u64. */
export interface KernelFee {
  amount: KernelCoin[];
  gas_limit: string;
}

/** What {@link ZuniaKernel.previewTx} returns: what will be signed, without signing it. */
export interface SigningPreview {
  chainId: string;
  mode: SignMode;
  messages: Array<{ typeUrl: string; summary: string; spendsFunds: boolean }>;
  summaries: string[];
  fee: KernelCoin[];
  /** String: a u64 does not survive a JSON number. */
  gasLimit: string;
  memo: string;
  spendsFunds: boolean;
  counterparties: string[];
  /** SHA-256 of the sign bytes, hex. Lets a user confirm prompt and broadcast match. */
  signBytesHash: string;
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

  /** What this kernel is and what it can do. Constant for the lifetime of the object. */
  readonly status: KernelStatus;

  /**
   * The bytes that must be signed for `msgsJson`, hex encoded. Pure: no key material
   * crosses this call, so it is safe to run before the wallet is unlocked.
   *
   * `msgsJson` is a JSON array of {@link KernelBuiltMsg}; `feeJson` is a {@link KernelFee}.
   * Throws {@link KernelUnavailableError} on the JS fallback.
   */
  buildSignBytes(
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

  /**
   * The broadcastable `TxRaw`, hex encoded, for a signature made over
   * {@link buildSignBytes}' output with the same arguments.
   *
   * The signature is not verified here, and it cannot be: a signature over different bytes
   * assembles without complaint and fails on chain as an opaque "unauthorized". Pass the
   * same arguments to both calls.
   */
  assembleTxRaw(
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

  /**
   * A `TxRaw` carrying a 64-byte zero signature, for `POST /cosmos/tx/v1beta1/simulate`.
   * Simulation does not verify signatures, but the transaction must still decode.
   */
  buildSimulateTx(
    chainId: string,
    msgsJson: string,
    feeJson: string,
    memo: string,
    accountNumber: U64Like,
    sequence: U64Like,
    publicKeyHex: string,
    ethKeyType: boolean,
  ): string;

  /**
   * derive -> sign bytes -> sign -> assemble, in one call. Returns a hex `TxRaw`.
   *
   * Holds the mnemonic, so unlike the pure calls above it is only safe in the background
   * worker. `chainJson` must be a full chain document (`chainId`, `bip44.coinType`,
   * `bech32Config.bech32PrefixAccAddr`, ...): this is the one entry point that can check the
   * chain it is signing for against the chain it derived a key from, and it refuses a
   * mismatch rather than signing with the wrong key.
   */
  signTx(
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

  /** What will be signed, for the approval screen. Pure: no key material crosses this call. */
  previewTx(
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

/**
 * CosmJS `serializeSignDoc`: recursively sort object keys, then
 * `JSON.stringify` (compact, insertion order = sorted). Sign bytes are the
 * UTF-8 encoding of that string — `signCosmos` hashes them with sha256.
 */
export function serializeAminoSignDoc(value: unknown): Uint8Array {
  return utf8Bytes(JSON.stringify(sortKeysDeep(value)));
}

function sortKeysDeep(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortKeysDeep(obj[key]);
  }
  return sorted;
}

/** Cosmos ADR-36 amino StdSignDoc (empty chain_id, MsgSignData, base64 data). */
export function adr36SignDoc(
  signer: string,
  dataBytes: Uint8Array,
): Record<string, unknown> {
  return {
    account_number: "0",
    chain_id: "",
    fee: { amount: [], gas: "0" },
    memo: "",
    msgs: [
      {
        type: "sign/MsgSignData",
        value: {
          data: toBase64(dataBytes),
          signer,
        },
      },
    ],
    sequence: "0",
  };
}

/**
 * Reject ADR-36 payloads that look like a real StdSignDoc so a dApp cannot
 * disguise a transaction as "sign this message".
 */
export function adr36PayloadIsSafe(data: Uint8Array): boolean {
  let text: string;
  try {
    text = new TextDecoder().decode(data);
  } catch {
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return true;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return true;
  }
  const map = parsed as Record<string, unknown>;
  const looksLikeStdSignDoc =
    "msgs" in map && "fee" in map && "chain_id" in map;
  return !looksLikeStdSignDoc;
}

/** Hex of ADR-36 amino sign bytes for {@link ZuniaKernel.signCosmos}. */
export function adr36SignBytesHex(signer: string, dataBytes: Uint8Array): string {
  const doc = adr36SignDoc(signer, dataBytes);
  return bytesToHex(serializeAminoSignDoc(doc));
}

/**
 * Verify a compact secp256k1 signature over ADR-36 sign bytes (sha256 digest).
 */
export function verifyAdr36(
  signer: string,
  dataBytes: Uint8Array,
  pubKey: Uint8Array,
  signature: Uint8Array,
): boolean {
  try {
    const signBytes = serializeAminoSignDoc(adr36SignDoc(signer, dataBytes));
    const digest = sha256(signBytes);
    return secp256k1.verify(signature, digest, pubKey, { prehash: false });
  } catch {
    return false;
  }
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

/**
 * Address payload for bech32. Cosmos uses tendermint(sha256→ripemd160) of the
 * compressed pubkey. Ethermint (coin type 60) uses the keccak of the
 * uncompressed pubkey's XY, which must be derived from the *private* key —
 * `getPublicKey` rejects a 33-byte compressed pubkey as if it were a scalar.
 */
function addressBytes(
  privateKey: Uint8Array,
  compressedPubKey: Uint8Array,
  ethermint: boolean,
): Uint8Array {
  if (ethermint) {
    const uncompressed = secp256k1.getPublicKey(privateKey, false);
    return keccak_256(uncompressed.slice(1)).slice(-20);
  }
  return ripemd160(sha256(compressedPubKey));
}

/**
 * Real kernel: every operation below is standards-compliant crypto. Addresses
 * match the Rust kernel vectors (all-`abandon` mnemonic, m/44'/118'/0'/0/0 →
 * cosmos19rl4cm2hmr8afy4kldpxz3fka4jguq0auqdal4).
 */
export function createLocalKernel(degradedReason?: string): ZuniaKernel {
  const deny = (method: string, reason?: string): never => {
    throw new KernelUnavailableError(method, "js", reason);
  };
  return {
    kernelVersion: () => JS_KERNEL_VERSION,

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
      try {
        const pubKey = secp256k1.getPublicKey(privateKey, true);
        const address = bech32.encode(
          chain.bech32Prefix,
          bech32.toWords(
            addressBytes(privateKey, pubKey, chain.ethermint),
          ),
        );
        return {
          address,
          bech32Address: address,
          algo: chain.ethermint ? "eth_secp256k1" : "secp256k1",
          pubKey,
          path,
        };
      } finally {
        privateKey.fill(0);
      }
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

    status: {
      flavor: "js",
      version: JS_KERNEL_VERSION,
      canSignTransactions: false,
      degradedReason,
    },

    // The five transaction methods below refuse rather than improvise. This kernel has no
    // protobuf encoder, no Amino encoder and no fee/auth_info assembly, so there is nothing
    // it could return that a chain would accept. Returning a plausible hex string here is
    // the exact defect the WASM kernel exists to remove: the caller broadcasts it, the chain
    // answers "unauthorized", and nothing in the wallet ever said why.
    buildSignBytes: () => deny("buildSignBytes", degradedReason),
    assembleTxRaw: () => deny("assembleTxRaw", degradedReason),
    buildSimulateTx: () => deny("buildSimulateTx", degradedReason),
    signTx: () => deny("signTx", degradedReason),
    previewTx: () => deny("previewTx", degradedReason),
  };
}

let kernelPromise: Promise<ZuniaKernel> | null = null;
let activeStatus: KernelStatus | null = null;

/**
 * The prefix `zunia-cosmos` gives a message it could not decode. Matched, not parsed: the
 * only thing this needs from it is "do not reassure the user about this one".
 */
const UNKNOWN_SUMMARY_PREFIX = "UNKNOWN ACTION:";

/**
 * Adapt the WASM module to {@link ZuniaKernel}.
 *
 * This takes over the five transaction methods, which the JS kernel cannot implement at all,
 * plus `decodeDirectTx`, whose JS version only pretends to decode. Everything else stays on
 * the JS kernel via the spread, deliberately:
 *
 *   * The mnemonic and keyring methods are correct there and have no WASM-only capability to
 *     gain.
 *   * The address methods cannot move yet. The WASM kernel needs a full chain document
 *     (`chainId`, `bip44.coinType`, `bech32Config.bech32PrefixAccAddr`, `rpc`, `rest`,
 *     currencies) and returns `{ address, publicKeyHex, path }`, where the extension's call
 *     sites pass `{ bech32Prefix, coinType }` and read `bech32Address` and a `pubKey` byte
 *     array. Swapping them without migrating those call sites first would turn every address
 *     derivation into a throw. Both kernels derive the same keys for the chains in use, so
 *     the mixture is safe; unifying it is a separate change.
 *
 * `decodeDirectTx` is adapted rather than passed through because the artifact reports
 * per-transaction summaries where this interface wants per-message objects. See the note on
 * `unknown` below, which is the part that matters for blind-signing gating.
 */
function adaptWasmKernel(
  mod: typeof import("@zunialab/core"),
  fallback: ZuniaKernel,
  version: string,
): ZuniaKernel {
  return {
    ...fallback,

    status: {
      flavor: "wasm",
      version,
      canSignTransactions: true,
    },

    decodeDirectTx: (signDocHex) => {
      const decoded = mod.decodeDirectTx(signDocHex);
      // If the kernel says something in here is undecodable but no individual summary
      // admits to it, mark every message unknown. Erring toward more blind-signing gating
      // than the truth costs a user one extra confirmation; erring the other way lets an
      // unreadable message through a screen that called it safe.
      const anyFlagged = decoded.summaries.some((s) =>
        s.startsWith(UNKNOWN_SUMMARY_PREFIX),
      );
      const messages: DecodedTxMessage[] = decoded.summaries.map((summary) => {
        const flagged = summary.startsWith(UNKNOWN_SUMMARY_PREFIX);
        const unknown =
          flagged || (decoded.hasUnknownMsgs && !anyFlagged) || undefined;
        return {
          // `decode_direct_tx` reports a type URL only for messages it could not decode,
          // where naming the type is the entire point of the summary. For the rest it
          // reports the rendered summary and nothing else, so this stays empty rather than
          // echoing the summary into it: a caller that shows `typeUrl` as a label should
          // show nothing, not a sentence dressed up as a protobuf type.
          typeUrl: flagged
            ? (summary.slice(UNKNOWN_SUMMARY_PREFIX.length).trim().split(" ")[0] ??
              "/unknown.Msg")
            : "",
          summary,
          ...(unknown ? { unknown: true } : {}),
        };
      });
      return {
        chainId: decoded.chainId,
        // Not carried across the boundary by `decode_direct_tx`, which reports only the
        // fields a signing prompt renders. No caller reads it today.
        accountNumber: "0",
        messages,
        memo: decoded.memo,
      };
    },

    buildSignBytes: (...args) => mod.buildSignBytes(...args),
    assembleTxRaw: (...args) => mod.assembleTxRaw(...args),
    buildSimulateTx: (...args) => mod.buildSimulateTx(...args),
    signTx: (...args) => mod.signTx(...args),
    previewTx: (...args) => mod.previewTx(...args),
  };
}

/** Every export the transaction surface needs. A partial module is treated as absent. */
const REQUIRED_WASM_EXPORTS = [
  "initZuniaCore",
  "kernelVersion",
  "decodeDirectTx",
  "buildSignBytes",
  "assembleTxRaw",
  "buildSimulateTx",
  "signTx",
  "previewTx",
] as const;

/**
 * Resolve the kernel, preferring the Rust/WASM build.
 *
 * The fallback is never silent: whichever kernel wins, {@link getKernelStatus} says which it
 * is and whether transactions can be signed, and the JS kernel throws
 * {@link KernelUnavailableError} from every transaction method. A half-loaded WASM module —
 * present but missing an export, or failing to instantiate — is treated as absent rather
 * than adopted, so there is no state in which some calls sign and others quietly do not.
 */
export function loadKernel(): Promise<ZuniaKernel> {
  if (!kernelPromise) {
    kernelPromise = (async () => {
      let reason: string | undefined;
      try {
        const mod = await import(/* @vite-ignore */ "@zunialab/core");
        const missing = REQUIRED_WASM_EXPORTS.filter(
          (name) => typeof (mod as Record<string, unknown>)[name] !== "function",
        );
        if (missing.length > 0) {
          reason = `@zunialab/core is missing ${missing.join(", ")}; the installed build is older than this extension`;
        } else {
          // The artifact is built for the wasm-bindgen `web` target, so nothing is
          // instantiated at import time and every export would be undefined until this
          // resolves. Under MV3 this is also where a missing 'wasm-unsafe-eval' in the
          // manifest CSP surfaces.
          await mod.initZuniaCore();
          const kernel = adaptWasmKernel(
            mod,
            createLocalKernel(),
            mod.kernelVersion(),
          );
          activeStatus = kernel.status;
          return kernel;
        }
      } catch (error) {
        reason =
          error instanceof Error
            ? `@zunialab/core failed to load: ${error.message}`
            : "@zunialab/core failed to load";
      }
      const kernel = createLocalKernel(reason ?? "@zunialab/core is not installed");
      activeStatus = kernel.status;
      return kernel;
    })();
  }
  return kernelPromise;
}

/**
 * Which kernel is active, for the UI to surface. `null` before {@link loadKernel} has
 * resolved; prefer {@link kernelStatus} when you can await.
 */
export function getKernelStatus(): KernelStatus | null {
  return activeStatus;
}

/** Which kernel is active, resolving the kernel first if it has not loaded yet. */
export async function kernelStatus(): Promise<KernelStatus> {
  return (await loadKernel()).status;
}

/** Test helper: force the in-process JS kernel. */
export function resetKernelForTests(): void {
  const kernel = createLocalKernel("forced by resetKernelForTests");
  activeStatus = kernel.status;
  kernelPromise = Promise.resolve(kernel);
}

export { sha256Hex, bytesToHex, hexToBytes, toBase64, fromBase64 };
