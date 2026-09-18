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
