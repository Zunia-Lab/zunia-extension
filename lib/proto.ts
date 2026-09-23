/**
 * Minimal protobuf writer for Cosmos TxRaw / message encoding.
 * Mirrors zunia-core ProtoWriter: ascending tags, skip proto3 defaults.
 */

export class ProtoWriter {
  private buf: number[] = [];
  private lastTag = 0;

  intoBytes(): Uint8Array {
    return new Uint8Array(this.buf);
  }

  private writeTag(tag: number, wire: 0 | 2): void {
    this.lastTag = tag;
    // writeVarint takes a bigint; the field key is small enough that the number
    // arithmetic above is exact, so widen it here rather than at every caller.
    writeVarint(this.buf, BigInt((tag << 3) | wire));
  }

  uint64(tag: number, value: number | bigint): this {
    const n = typeof value === "bigint" ? value : BigInt(value);
    if (n === 0n) return this;
    this.writeTag(tag, 0);
    writeVarint(this.buf, n);
    return this;
  }

  int32(tag: number, value: number): this {
    if (value === 0) return this;
    this.writeTag(tag, 0);
    writeVarint(this.buf, BigInt(value >>> 0));
    return this;
  }

  string(tag: number, value: string): this {
    if (!value) return this;
    const bytes = utf8(value);
    this.writeTag(tag, 2);
    writeVarint(this.buf, BigInt(bytes.length));
    this.buf.push(...bytes);
    return this;
  }

  bytes(tag: number, value: Uint8Array): this {
    if (value.length === 0) return this;
    this.writeTag(tag, 2);
    writeVarint(this.buf, BigInt(value.length));
    this.buf.push(...value);
    return this;
  }

  message(tag: number, value: Uint8Array): this {
    return this.bytes(tag, value);
  }

  messageAlways(tag: number, value: Uint8Array): this {
    this.writeTag(tag, 2);
    writeVarint(this.buf, BigInt(value.length));
    this.buf.push(...value);
    return this;
  }

  repeatedMessage(tag: number, values: Uint8Array[]): this {
    for (const value of values) {
      this.writeTag(tag, 2);
      writeVarint(this.buf, BigInt(value.length));
      this.buf.push(...value);
      this.lastTag = tag;
    }
    return this;
  }
}

/** One top-level field of a protobuf message. */
export interface ProtoField {
  readonly field: number;
  readonly wireType: number;
  /** The whole field, key included, exactly as it was encoded. */
  readonly raw: Uint8Array;
  /** The payload of a length-delimited field. */
  readonly bytes?: Uint8Array;
  /** The value of a varint field. */
  readonly varint?: bigint;
}

/**
 * Split a message into its top-level fields without knowing its schema.
 * Throws on anything truncated or malformed rather than guessing.
 */
export function readProtoFields(bytes: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let offset = 0;

  const readVarint = (): bigint => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const byte = bytes[offset];
      if (byte === undefined) throw new Error("Truncated protobuf varint");
      offset += 1;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 63n) throw new Error("Protobuf varint too long");
    }
  };

  while (offset < bytes.length) {
    const start = offset;
    const key = readVarint();
    const field = Number(key >> 3n);
    const wireType = Number(key & 7n);
    if (field === 0) throw new Error("Invalid protobuf field number");
    let payload: Uint8Array | undefined;
    let varint: bigint | undefined;
    switch (wireType) {
      case 0:
        varint = readVarint();
        break;
      case 1:
        offset += 8;
        break;
      case 2: {
        const length = Number(readVarint());
        if (offset + length > bytes.length) throw new Error("Truncated protobuf field");
        payload = bytes.subarray(offset, offset + length);
        offset += length;
        break;
      }
      case 5:
        offset += 4;
        break;
      default:
        throw new Error(`Unsupported protobuf wire type ${wireType}`);
    }
    if (offset > bytes.length) throw new Error("Truncated protobuf field");
    fields.push({
      field,
      wireType,
      raw: bytes.subarray(start, offset),
      ...(payload ? { bytes: payload } : {}),
      ...(varint !== undefined ? { varint } : {}),
    });
  }
  return fields;
}

/** The encoding of a length-delimited field, for splicing next to raw fields. */
export function lengthDelimitedField(field: number, payload: Uint8Array): Uint8Array {
  const out: number[] = [];
  writeVarint(out, BigInt((field << 3) | 2));
  writeVarint(out, BigInt(payload.length));
  out.push(...payload);
  return Uint8Array.from(out);
}

function writeVarint(buf: number[], value: bigint): void {
  let n = value;
  for (;;) {
    const byte = Number(n & 0x7fn);
    n >>= 7n;
    if (n === 0n) {
      buf.push(byte);
      return;
    }
    buf.push(byte | 0x80);
  }
}

function utf8(value: string): number[] {
  return Array.from(new TextEncoder().encode(value));
}
