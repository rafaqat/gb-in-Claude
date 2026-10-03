// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/**
 * Audio records in GarageBand ProjectData (field map checked on GarageBand 10.4.14):
 * - AuFl (audio file): UTF-16LE file name (char count u16 @+0x08, text @+0x0A), then a WAVE descriptor ("EVAW")
 *   whose position moves with the name length — so every format field is read relative to it.
 * - AuRg (audio region): length in frames u32 @+0x16; display name = [u16 length][ASCII][pad to even] @+0x4A,
 *   and the record is sized to fit the name (everything after it shifts).
 */
import { err, ok, type Result } from "../result.js";
import type { ProjectData } from "./projectdata.js";

export type AudioFile = { filename: string; frames: number; rate: number; channels: number; bits: number; fileSize: number; folder: string };
export type AudioError = { code: "NO_WAVE_DESCRIPTOR" | "FOLDER_TOO_LONG"; message: string };

const NAME_CHARS_AT = 0x08;
const NAME_AT = 0x0a;
const WAVE = [0x45, 0x56, 0x41, 0x57]; // "EVAW"
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

// Fields relative to the WAVE descriptor (e): the folder path is a NUL-terminated string in [e-0x13E, e-0x62).
const FOLDER_FROM = 0x13e;
const FOLDER_TO = 0x62;
const FILE_SIZE_BEFORE = 0x32;

const find = (b: Uint8Array, needle: readonly number[]) => {
  for (let i = 0; i + needle.length <= b.length; i++) if (needle.every((n, j) => b[i + j] === n)) return i;
  return -1;
};

const waveAt = (p: Uint8Array): Result<number, AudioError> => {
  const e = find(p, WAVE);
  return e < FOLDER_FROM ? err({ code: "NO_WAVE_DESCRIPTOR", message: "the audio file record has no WAVE descriptor" }) : ok(e);
};

/** A new AuFl payload for `file`: the name is resized in place (nothing after it is addressed by offset). */
export function writeAudioFile(p: Uint8Array, file: AudioFile): Result<Uint8Array, AudioError> {
  const oldChars = view(p).getUint16(NAME_CHARS_AT, true);
  const name = Buffer.from(file.filename, "utf16le");
  const out = new Uint8Array(p.length - 2 * oldChars + name.length);
  out.set(p.subarray(0, NAME_AT));
  out.set(name, NAME_AT);
  out.set(p.subarray(NAME_AT + 2 * oldChars), NAME_AT + name.length);
  const v = view(out);
  v.setUint16(NAME_CHARS_AT, file.filename.length, true);
  const at = waveAt(out);
  if (!at.ok) return at;
  const e = at.value;
  v.setUint32(e + 0x0c, file.frames, true);
  v.setUint32(e + 0x14, file.rate, true);
  v.setUint16(e + 0x18, file.channels, true);
  v.setUint16(e + 0x1a, file.bits, true);
  v.setUint32(e - FILE_SIZE_BEFORE, file.fileSize, true);
  const folder = new TextEncoder().encode(file.folder);
  if (folder.length >= FOLDER_FROM - FOLDER_TO) return err({ code: "FOLDER_TOO_LONG", message: "the folder path does not fit the file record" });
  out.fill(0, e - FOLDER_FROM, e - FOLDER_TO);
  out.set(folder, e - FOLDER_FROM);
  return ok(out);
}

export function readAudioFile(p: Uint8Array): Result<AudioFile, AudioError> {
  const v = view(p);
  const chars = v.getUint16(NAME_CHARS_AT, true);
  const filename = new TextDecoder("utf-16le").decode(p.subarray(NAME_AT, NAME_AT + 2 * chars));
  const at = waveAt(p);
  if (!at.ok) return at;
  const e = at.value;
  const folderBytes = p.subarray(e - FOLDER_FROM, e - FOLDER_TO);
  const end = folderBytes.indexOf(0);
  return ok({
    filename,
    frames: v.getUint32(e + 0x0c, true),
    rate: v.getUint32(e + 0x14, true),
    channels: v.getUint16(e + 0x18, true),
    bits: v.getUint16(e + 0x1a, true),
    fileSize: v.getUint32(e - FILE_SIZE_BEFORE, true),
    folder: new TextDecoder().decode(folderBytes.subarray(0, end < 0 ? folderBytes.length : end)),
  });
}

export type AudioRegion = { name: string; frames: number };

const REGION_FRAMES_AT = 0x16;
const REGION_NAME_AT = 0x4a;

export function readAudioRegion(p: Uint8Array): AudioRegion {
  const v = view(p);
  const length = v.getUint16(REGION_NAME_AT, true);
  return {
    name: new TextDecoder("latin1").decode(p.subarray(REGION_NAME_AT + 2, REGION_NAME_AT + 2 + length)),
    frames: v.getUint32(REGION_FRAMES_AT, true),
  };
}

const nameSpan = (length: number) => 2 + length + (length & 1);

/** A new AuRg payload with `region`'s name (the record is resized to fit) and length; the bytes after the name stay. */
export function writeAudioRegion(p: Uint8Array, region: AudioRegion): Uint8Array {
  const oldSpan = nameSpan(view(p).getUint16(REGION_NAME_AT, true));
  const name = new TextEncoder().encode(region.name);
  const span = nameSpan(name.length);
  const out = new Uint8Array(p.length - oldSpan + span);
  out.set(p.subarray(0, REGION_NAME_AT));
  view(out).setUint16(REGION_NAME_AT, name.length, true);
  out.set(name, REGION_NAME_AT + 2);
  out.set(p.subarray(REGION_NAME_AT + oldSpan), REGION_NAME_AT + span);
  view(out).setUint32(REGION_FRAMES_AT, region.frames, true);
  return out;
}

/** Region positions are stored as 34560 (= 9 bars of 4/4 at 960 PPQ) + ticks from the song start. */
export const REGION_ORIGIN = 34560;
const PLACEMENT = 0x24;
const EVENT_SIZE = 80;
const TAIL_SIZE = 16;

/** A placement event: its host record and byte offset, start tick, 1-based track, and the index of the region it shows. */
export type AudioPlacement = { record: number; offset: number; tick: number; track: number; region: number };

const LINK_AT = 0x2c;
const TRACK_AT = 0x14;
/** Region records (AuFl + AuRg) carry their region index in the record header: group u32 @+8 = index × 0x40000. */
export const REGION_GROUP = 0x40000;
export const groupOf = (header: Uint8Array) => new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(8, true);

/** Marker of a MIDI region placement — it shares the arrange list with audio placements (0x24). */
const MIDI_PLACEMENT = 0x20;
const isPlacement = (marker: number | undefined) => marker === PLACEMENT || marker === MIDI_PLACEMENT;

/** Every audio placement event (0x24) in the arrange lists — event lists of 80-byte placements, audio and MIDI mixed. */
/** More audio placements than any donor or song gb_band handles: such a project is refused, not processed. */
export const MAX_PLACEMENTS = 4096;

export function audioPlacements(pd: ProjectData): AudioPlacement[] {
  const out: AudioPlacement[] = [];
  pd.records.forEach((r, record) => {
    if (r.tag !== "EvSq" || !isPlacement(r.payload[0])) return;
    const v = view(r.payload);
    for (let offset = 0; offset + EVENT_SIZE <= r.payload.length - TAIL_SIZE && isPlacement(r.payload[offset]); offset += EVENT_SIZE) {
      if (r.payload[offset] !== PLACEMENT) continue;
      out.push({
        record, offset, tick: Number(v.getBigUint64(offset + 4, true)) - REGION_ORIGIN,
        track: r.payload[offset + TRACK_AT]!, region: v.getUint32(offset + LINK_AT, true) / 4,
      });
    }
  });
  return out;
}

/** A copy of `pd` with one placement moved to `tick`; only the event's position is rewritten. */
export function withPlacementTick(pd: ProjectData, placement: AudioPlacement, tick: number): ProjectData {
  return withPlacement(pd, placement, { tick, track: placement.track });
}

/** A copy of `pd` with one placement at `tick` on `track`; flag, id and link stay as GarageBand wrote them. */
export function withPlacement(pd: ProjectData, placement: AudioPlacement, at: { tick: number; track: number }): ProjectData {
  const records = pd.records.slice();
  const host = records[placement.record]!;
  const payload = host.payload.slice();
  view(payload).setBigUint64(placement.offset + 4, BigInt(REGION_ORIGIN + at.tick), true);
  payload[placement.offset + TRACK_AT] = at.track;
  records[placement.record] = { ...host, payload };
  return { ...pd, records };
}

/** The AuFl and AuRg record indexes of every region (or -1), from one pass over the records. */
export function regionIndex(pd: ProjectData): (index: number) => { file: number; region: number } {
  const first = new Map<string, number>();
  pd.records.forEach((r, i) => {
    if (r.tag !== "AuFl" && r.tag !== "AuRg") return;
    const key = `${r.tag}:${groupOf(r.header)}`;
    if (!first.has(key)) first.set(key, i);
  });
  return (index) => ({ file: first.get(`AuFl:${index * REGION_GROUP}`) ?? -1, region: first.get(`AuRg:${index * REGION_GROUP}`) ?? -1 });
}

/** Indexes of the AuFl and AuRg records of region `index` (or -1). One lookup: in a loop, use regionIndex. */
export function regionRecords(pd: ProjectData, index: number): { file: number; region: number } {
  return regionIndex(pd)(index);
}

/** For each placement in order: the file name, region name and length of the records it links to ("" / 0 if missing). */
export function linkedAudio(pd: ProjectData): { filename: string; regionName: string; frames: number }[] {
  const records = regionIndex(pd);
  return audioPlacements(pd).map((p) => {
    const at = records(p.region);
    const file = at.file >= 0 ? readAudioFile(pd.records[at.file]!.payload) : undefined;
    const region = at.region >= 0 ? readAudioRegion(pd.records[at.region]!.payload) : { name: "", frames: 0 };
    return { filename: file?.ok ? file.value.filename : "", regionName: region.name, frames: region.frames };
  });
}

/**
 * A copy of `pd` without the regions whose index is `from` or higher: their placement events are cut from their
 * lists, and their AuFl/AuRg records and their per-region GenM (group (index + 1) × 0x40000) are dropped.
 * Only the highest indexes are removed, so the remaining regions keep contiguous indexes.
 */
export function withoutRegionsFrom(pd: ProjectData, from: number): ProjectData {
  const records = pd.records.slice();
  const cuts = new Map<number, Set<number>>(); // host record → offsets of its events to cut
  for (const p of audioPlacements(pd)) {
    if (p.region >= from) cuts.set(p.record, (cuts.get(p.record) ?? new Set()).add(p.offset));
  }
  for (const [record, offsets] of cuts) { // one new payload per host record (linear)
    const host = records[record]!;
    const payload = new Uint8Array(host.payload.length - EVENT_SIZE * offsets.size);
    let to = 0;
    let at = 0;
    for (const cut of [...offsets].sort((a, b) => a - b)) {
      payload.set(host.payload.subarray(at, cut), to);
      to += cut - at;
      at = cut + EVENT_SIZE;
    }
    payload.set(host.payload.subarray(at), to);
    records[record] = { ...host, payload };
  }
  const dropped = (r: ProjectData["records"][number]) => {
    const group = groupOf(r.header);
    if ((r.tag === "AuFl" || r.tag === "AuRg") && group >= from * REGION_GROUP) return true;
    return r.tag === "GenM" && group >= (from + 1) * REGION_GROUP;
  };
  return { ...pd, records: records.filter((r) => !dropped(r)) };
}
