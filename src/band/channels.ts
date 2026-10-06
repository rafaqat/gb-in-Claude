// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/**
 * Audio channels in ProjectData (M13.18, found 2026-10-05 by saving a project before and after a pan change): every
 * channel object (Audio 1…n, inputs, aux, buses, outputs) is an `AuCO` record whose header u32 at +0x0C holds its
 * index in the high 16 bits; its name is ASCII at +0x3D and its pan one byte at +0x59 (pan + 64: 0x00 hard left,
 * 0x40 centre, 0x7F hard right). An audio track's channel strip (`Envi`, name at 0xA0, length at 0x9E) carries the
 * same name and, 4 bytes after the name, that index — both must match.
 */
import { err, ok, type Result } from "../result.js";
import type { ProjectData } from "./projectdata.js";

const NAME_AT = 0x3d, NAME_END = 0x50, PAN_AT = 0x59;
const header = (r: { header: Uint8Array }) => new DataView(r.header.buffer, r.header.byteOffset, r.header.byteLength);

function stripName(pd: ProjectData, strip: number): { name: string; index: number } | null {
  const envi = pd.records.find((r) => r.tag === "Envi" && header(r).getUint32(8, true) === strip << 16);
  if (!envi) return null;
  const p = envi.payload;
  const len = p[0x9e] ?? 0;
  if (len === 0 || 0xa0 + len + 5 > p.length) return null;
  if ((p[0x60]! & 0x80) !== 0) return null; // an instrument strip: no audio channel
  return { name: new TextDecoder().decode(p.subarray(0xa0, 0xa0 + len)), index: p[0xa0 + len + 4]! };
}

const auco = (pd: ProjectData) => pd.records.map((r, i) => ({ r, i })).filter(({ r }) => r.tag === "AuCO" && r.payload.length > PAN_AT);
const nameOf = (p: Uint8Array) => {
  const end = p.subarray(NAME_AT, NAME_END).indexOf(0);
  return new TextDecoder().decode(p.subarray(NAME_AT, end < 0 ? NAME_END : NAME_AT + end));
};

/** The audio channel of a track's strip: its record, name and pan (−64…+63). */
export function audioChannel(pd: ProjectData, strip: number): Result<{ record: number; name: string; pan: number }, string> {
  const s = stripName(pd, strip);
  if (!s) return err(`strip ${strip} is not an audio channel strip`);
  const hits = auco(pd).filter(({ r }) => header(r).getUint32(12, true) >>> 16 === s.index && nameOf(r.payload) === s.name);
  if (hits.length !== 1) return err(`${hits.length} audio channel records match strip ${strip} (${s.name}, index ${s.index})`);
  const { r, i } = hits[0]!;
  return ok({ record: i, name: s.name, pan: r.payload[PAN_AT]! - 64 });
}

/** pd with the track's audio channel panned (−64 hard left … +63 hard right); refuses a strip without one. */
export function withPan(pd: ProjectData, strip: number, pan: number): Result<ProjectData, string> {
  if (!Number.isInteger(pan) || pan < -64 || pan > 63) return err("pan must be an integer from -64 to 63");
  const ch = audioChannel(pd, strip);
  if (!ch.ok) return ch;
  const records = pd.records.slice();
  const payload = records[ch.value.record]!.payload.slice();
  payload[PAN_AT] = pan + 64;
  records[ch.value.record] = { ...records[ch.value.record]!, payload };
  return ok({ ...pd, records });
}
