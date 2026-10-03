// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/**
 * GarageBand 10.4.14's `Alternatives/000/ProjectData` — the Logic Pro song binary (same container as Logic Pro
 * 11.2.2, version code D0 09). Layout per LogicProFormatWriter's PROJECTDATA_FORMAT.md (MIT): a 24-byte root
 * header, then records of a 36-byte header (reversed FourCC tag at +0x00, payload size u32 at +0x1C) + payload.
 * There are no absolute offsets, so records may grow or shrink as long as the root length is kept in step.
 */
import { err, ok, type Result } from "../result.js";

export const MAGIC = [0x23, 0x47, 0xc0, 0xab] as const;
export const ROOT_HEADER = 24;
export const RECORD_HEADER = 0x24;
const ROOT_LENGTH_AT = 0x10;
const PAYLOAD_SIZE_AT = 0x1c;

export type BandRecord = { tag: string; header: Uint8Array; payload: Uint8Array };
export type ProjectData = { root: Uint8Array; records: BandRecord[] };
export type BandError = { code: "NOT_PROJECTDATA" | "BAD_ROOT_LENGTH" | "TRUNCATED_RECORD"; message: string };

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const tagOf = (b: Uint8Array, at: number) => String.fromCharCode(b[at + 3]!, b[at + 2]!, b[at + 1]!, b[at]!);

export function parseProjectData(bytes: Uint8Array): Result<ProjectData, BandError> {
  if (bytes.length < ROOT_HEADER || MAGIC.some((m, i) => bytes[i] !== m)) {
    return err({ code: "NOT_PROJECTDATA", message: "missing the ProjectData magic 23 47 C0 AB" });
  }
  const v = view(bytes);
  if (v.getUint32(ROOT_LENGTH_AT, true) !== bytes.length - ROOT_HEADER) {
    return err({ code: "BAD_ROOT_LENGTH", message: "the root length does not match the file size" });
  }
  const records: BandRecord[] = [];
  let at = ROOT_HEADER;
  while (at < bytes.length) {
    if (at + RECORD_HEADER > bytes.length) {
      return err({ code: "TRUNCATED_RECORD", message: `record header at ${at} runs past the end` });
    }
    const size = v.getUint32(at + PAYLOAD_SIZE_AT, true);
    const end = at + RECORD_HEADER + size;
    if (end > bytes.length) {
      return err({ code: "TRUNCATED_RECORD", message: `record at ${at} runs past the end` });
    }
    records.push({ tag: tagOf(bytes, at), header: bytes.slice(at, at + RECORD_HEADER), payload: bytes.slice(at + RECORD_HEADER, end) });
    at = end;
  }
  return ok({ root: bytes.slice(0, ROOT_HEADER), records });
}

/** Concatenates the records; every payload size and the root length are written from the actual lengths. */
export function serializeProjectData(pd: ProjectData): Uint8Array {
  const headers = pd.records.map((r) => {
    const h = r.header.slice();
    view(h).setUint32(PAYLOAD_SIZE_AT, r.payload.length, true);
    return h;
  });
  const parts = [pd.root.slice(), ...pd.records.flatMap((r, i) => [headers[i]!, r.payload])];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  view(out).setUint32(ROOT_LENGTH_AT, out.length - ROOT_HEADER, true);
  return out;
}
