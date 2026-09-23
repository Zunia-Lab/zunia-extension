/**
 * Checks that sit between a dApp's request and the signing kernel.
 *
 * Everything here is pure so it can be tested without a browser: turning the
 * bytes a page sends over `runtime.sendMessage` (which JSON-serializes, so a
 * `Uint8Array` arrives as `{ "0": 10, "1": 3, ... }`) back into bytes, encoding
 * the exact protobuf `SignDoc` the chain will verify, and refusing documents
 * whose chain does not match the one the dApp was approved for.
 */

export class ProviderGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderGuardError";
  }
}

const HEX_RE = /^(?:0x)?[0-9a-fA-F]*$/;
const BASE64_RE = /^[A-Za-z0-9+/_-]*={0,2}$/;
const MAX_WIRE_BYTES = 256 * 1024;

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function base64ToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function checkByte(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255) {
    throw new ProviderGuardError(`${label} is not a byte array`);
  }
  return value;
}

/**
 * Bytes from whatever survived the page-to-extension hop: a `Uint8Array`, a plain
 * number array, the index-keyed object JSON makes of a typed array, a base64
 * string, or a 0x-prefixed hex string.
 */
export function bytesFromWire(value: unknown, label: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) {
    if (value.length > MAX_WIRE_BYTES) throw new ProviderGuardError(`${label} is too large`);
    return Uint8Array.from(value, (v) => checkByte(v, label));
  }
  if (typeof value === "string") {
    if (value.length > MAX_WIRE_BYTES * 2) throw new ProviderGuardError(`${label} is too large`);
    // Hex only with its 0x prefix: plain hex is also valid base64, and reading
    // the same string two ways would sign different bytes than the page meant.
    if (value.startsWith("0x")) {
      if (value.length % 2 === 0 && HEX_RE.test(value)) return hexToBytes(value);
      throw new ProviderGuardError(`${label} is not valid hex`);
    }
    if (BASE64_RE.test(value)) {
      try {
        return base64ToBytes(value);
      } catch {
        // fall through to the error below
      }
    }
    throw new ProviderGuardError(`${label} is not hex or base64`);
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > MAX_WIRE_BYTES) throw new ProviderGuardError(`${label} is too large`);
    const out = new Uint8Array(entries.length);
    for (const [key, byte] of entries) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= entries.length) {
        throw new ProviderGuardError(`${label} is not a byte array`);
      }
      out[index] = checkByte(byte, label);
    }
    return out;
  }
  throw new ProviderGuardError(`${label} is missing`);
}

const MAX_U64 = (1n << 64n) - 1n;

/** An unsigned 64-bit integer from a bigint, number, decimal string, or Long-like object. */
export function u64FromWire(value: unknown, label: string): bigint {
  let out: bigint;
  if (typeof value === "bigint") out = value;
  else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new ProviderGuardError(`${label} is not an integer`);
    out = BigInt(value);
  } else if (typeof value === "string") {
    if (!/^\d{1,20}$/.test(value.trim())) {
      throw new ProviderGuardError(`${label} is not an integer`);
    }
    out = BigInt(value.trim());
  } else if (value && typeof value === "object" && "low" in value && "high" in value) {
    const { low, high } = value as { low: unknown; high: unknown };
    if (typeof low !== "number" || typeof high !== "number") {
      throw new ProviderGuardError(`${label} is not an integer`);
    }
    out = (BigInt(high >>> 0) << 32n) | BigInt(low >>> 0);
  } else if (value === undefined || value === null) {
    out = 0n;
  } else {
    throw new ProviderGuardError(`${label} is not an integer`);
  }
  if (out < 0n || out > MAX_U64) throw new ProviderGuardError(`${label} is out of range`);
  return out;
}

export interface DirectSignDoc {
  bodyBytes: Uint8Array;
  authInfoBytes: Uint8Array;
  chainId: string;
  accountNumber: bigint;
}

export function normalizeDirectSignDoc(raw: unknown): DirectSignDoc {
  if (!raw || typeof raw !== "object") {
    throw new ProviderGuardError("signDoc must be an object");
  }
  const doc = raw as Record<string, unknown>;
  if (typeof doc.chainId !== "string" || !doc.chainId) {
    throw new ProviderGuardError("signDoc.chainId is missing");
  }
  const bodyBytes = bytesFromWire(doc.bodyBytes, "signDoc.bodyBytes");
  if (bodyBytes.length === 0) throw new ProviderGuardError("signDoc.bodyBytes is empty");
  return {
    bodyBytes,
    authInfoBytes: bytesFromWire(doc.authInfoBytes, "signDoc.authInfoBytes"),
    chainId: doc.chainId,
    accountNumber: u64FromWire(doc.accountNumber, "signDoc.accountNumber"),
  };
}

function varint(value: bigint): number[] {
  const out: number[] = [];
  let v = value;
  while (v > 0x7fn) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
  return out;
}

function lengthDelimited(field: number, bytes: Uint8Array): number[] {
  return [(field << 3) | 2, ...varint(BigInt(bytes.length)), ...bytes];
}

/**
 * The protobuf encoding of `cosmos.tx.v1beta1.SignDoc`, identical to CosmJS
 * `makeSignBytes`: fields 1 to 4 in order, proto3 defaults omitted.
 */
export function encodeDirectSignDoc(doc: DirectSignDoc): Uint8Array {
  const out: number[] = [];
  if (doc.bodyBytes.length) out.push(...lengthDelimited(1, doc.bodyBytes));
  if (doc.authInfoBytes.length) out.push(...lengthDelimited(2, doc.authInfoBytes));
  if (doc.chainId) out.push(...lengthDelimited(3, new TextEncoder().encode(doc.chainId)));
  if (doc.accountNumber > 0n) out.push(0x20, ...varint(doc.accountNumber));
  return Uint8Array.from(out);
}

/** The shape handed back to the page: plain arrays and a decimal string survive JSON. */
export function directSignDocToWire(doc: DirectSignDoc): {
  bodyBytes: number[];
  authInfoBytes: number[];
  chainId: string;
  accountNumber: string;
} {
  return {
    bodyBytes: Array.from(doc.bodyBytes),
    authInfoBytes: Array.from(doc.authInfoBytes),
    chainId: doc.chainId,
    accountNumber: doc.accountNumber.toString(),
  };
}

export function aminoSignDocChainId(signDoc: unknown): string {
  if (!signDoc || typeof signDoc !== "object") {
    throw new ProviderGuardError("signDoc must be an object");
  }
  const doc = signDoc as Record<string, unknown>;
  if (typeof doc.chain_id !== "string" || !doc.chain_id) {
    throw new ProviderGuardError("signDoc.chain_id is missing");
  }
  if (!Array.isArray(doc.msgs)) throw new ProviderGuardError("signDoc.msgs must be an array");
  return doc.chain_id;
}

/**
 * The chain the dApp asked to sign on must be the chain named inside the document.
 * A mismatch is refused outright rather than shown as a warning: the approval was
 * granted for one chain and the signature would be valid on another.
 */
export function assertSameChain(requested: string, inDocument: string): void {
  if (requested !== inDocument) {
    throw new ProviderGuardError(
      `The document is for ${inDocument || "an unnamed chain"}, not ${requested}. Zunia refused to sign it.`,
    );
  }
}

/** The signer the dApp named must be the account Zunia would sign with. */
export function assertSigner(requested: unknown, active: string): void {
  if (typeof requested !== "string" || requested !== active) {
    throw new ProviderGuardError(
      "The requested signer is not the active account for this site. Switch accounts in Zunia and try again.",
    );
  }
}
