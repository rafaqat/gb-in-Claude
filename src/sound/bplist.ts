// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { ok, err, type Result } from "../result.js";

/**
 * Minimal, dependency-free reader for Apple binary property lists ("bplist00"), enough for
 * GarageBand patch metadata. Bounds-checked, depth-limited, never throws: malformed input → err.
 * Supports null/bool, int (1–8 bytes), real (4/8), date, data, ASCII and UTF-16 strings, UID, array, set, dict.
 */
const MAX_DEPTH = 32;
const TRAILER_SIZE = 32;

class PlistError extends Error {}

export function parseBinaryPlist(buf: Uint8Array): Result<unknown, string> {
  try {
    return ok(new Reader(buf).read());
  } catch (e) {
    return err(e instanceof PlistError ? e.message : `malformed bplist (${String(e)})`);
  }
}

class Reader {
  private readonly view: DataView;
  private readonly offsets: number[] = [];
  private readonly refSize: number;
  private readonly top: number;

  constructor(private readonly buf: Uint8Array) {
    if (buf.length < 8 + TRAILER_SIZE || new TextDecoder("latin1").decode(buf.subarray(0, 8)) !== "bplist00") {
      throw new PlistError("not a bplist00 file");
    }
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const t = buf.length - TRAILER_SIZE;
    const offsetSize = buf[t + 6]!;
    this.refSize = buf[t + 7]!;
    const count = this.uint(t + 8, 8);
    this.top = this.uint(t + 16, 8);
    const tableAt = this.uint(t + 24, 8);
    if (offsetSize < 1 || offsetSize > 8 || this.refSize < 1 || this.refSize > 8) throw new PlistError("bad trailer sizes");
    if (tableAt + count * offsetSize > t || this.top >= count) throw new PlistError("bad offset table");
    for (let i = 0; i < count; i++) this.offsets.push(this.uint(tableAt + i * offsetSize, offsetSize));
  }

  read(): unknown {
    return this.object(this.top, 0);
  }

  private uint(at: number, size: number): number {
    if (at < 0 || at + size > this.buf.length) throw new PlistError("read past end");
    let v = 0;
    for (let i = 0; i < size; i++) v = v * 256 + this.buf[at + i]!;
    return v;
  }

  /** Low nibble 0xF means the length follows as an int object. Returns [length, offset of payload]. */
  private length(info: number, at: number): [number, number] {
    if (info !== 0x0f) return [info, at + 1];
    const marker = this.buf[at + 1];
    if (marker === undefined || marker >> 4 !== 0x1) throw new PlistError("bad length marker");
    const size = 1 << (marker & 0x0f);
    return [this.uint(at + 2, size), at + 2 + size];
  }

  private object(ref: number, depth: number): unknown {
    if (depth > MAX_DEPTH) throw new PlistError("nesting too deep");
    const at = this.offsets[ref];
    if (at === undefined) throw new PlistError(`bad object ref ${ref}`);
    const marker = this.buf[at];
    if (marker === undefined) throw new PlistError("read past end");
    const type = marker >> 4;
    const info = marker & 0x0f;
    switch (type) {
      case 0x0:
        if (info === 0x0) return null;
        if (info === 0x8) return false;
        if (info === 0x9) return true;
        throw new PlistError(`unsupported singleton 0x${marker.toString(16)}`);
      case 0x1: {
        const size = 1 << info;
        if (size > 8) throw new PlistError("int wider than 8 bytes");
        if (at + 1 + size > this.buf.length) throw new PlistError("read past end");
        if (size < 8) return this.uint(at + 1, size);
        const big = this.view.getBigInt64(at + 1);
        return big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big.toString();
      }
      case 0x2:
        if (info === 2) return this.view.getFloat32(at + 1);
        if (info === 3) return this.view.getFloat64(at + 1);
        throw new PlistError("unsupported real size");
      case 0x3:
        return new Date((978307200 + this.view.getFloat64(at + 1)) * 1000).toISOString(); // seconds since 2001
      case 0x4: {
        const [n, p] = this.length(info, at);
        if (p + n > this.buf.length) throw new PlistError("read past end");
        return this.buf.slice(p, p + n);
      }
      case 0x5: {
        const [n, p] = this.length(info, at);
        if (p + n > this.buf.length) throw new PlistError("read past end");
        return new TextDecoder("latin1").decode(this.buf.subarray(p, p + n));
      }
      case 0x6: {
        const [n, p] = this.length(info, at);
        if (p + 2 * n > this.buf.length) throw new PlistError("read past end");
        let s = "";
        for (let i = 0; i < n; i++) s += String.fromCharCode(this.view.getUint16(p + 2 * i));
        return s;
      }
      case 0x8:
        return { uid: this.uint(at + 1, info + 1) };
      case 0xa:
      case 0xc: {
        const [n, p] = this.length(info, at);
        return Array.from({ length: n }, (_, i) => this.object(this.uint(p + i * this.refSize, this.refSize), depth + 1));
      }
      case 0xd: {
        const [n, p] = this.length(info, at);
        const dict: Record<string, unknown> = {};
        for (let i = 0; i < n; i++) {
          const key = this.object(this.uint(p + i * this.refSize, this.refSize), depth + 1);
          if (typeof key !== "string") throw new PlistError("non-string dict key");
          dict[key] = this.object(this.uint(p + (n + i) * this.refSize, this.refSize), depth + 1);
        }
        return dict;
      }
      default:
        throw new PlistError(`unsupported object type 0x${type.toString(16)}`);
    }
  }
}
