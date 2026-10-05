// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/**
 * New audio-region slots on a project's audio tracks (M11b) — so a project GarageBand made from our MIDI (plus empty
 * audio tracks it added) can take stems, with no hand-made donor. Each slot is a copy of AUDIO_SLOT_TEMPLATE made its
 * own, following what GarageBand writes (checked on GarageBand 10.4.14 saves, eval/m11b/BAND-FORMAT.md):
 * - region n: AuFl + AuRg in group n × 0x40000, its GenM in group (n + 1) × 0x40000 with u32 @+0x0C = n × 4;
 * - the audio files form a chain: relative to each AuFl's "EVAW", +0x38 = n + 1 and +0x3E = the next region × 4
 *   (0xFFFFFFFF for the last);
 * - a region's identity (16 random bytes in AuRg: 4 @+0x2A, 4 + 8 after its name) is new for every slot;
 * - its placement (80 bytes, appended to the track list) carries the track's channel strip @+0x10, the track number
 *   @+0x14 and the link n × 4 @+0x2C; the track gets GarageBand's "holds regions" flag.
 * Live proof: a graft onto a MIDI import's empty Audio 1 opened clean, GarageBand's re-save kept the region, and the
 * export played it at bar 1 (correlation 0.96 with the source) with the MIDI track intact.
 */
import { randomBytes } from "node:crypto";
import { err, ok, type Result } from "../result.js";
import type { BandRecord, ProjectData } from "./projectdata.js";
import { groupOf, REGION_GROUP } from "./audio.js";
import { TRACK_HOLDS_REGIONS, visibleTracks } from "./tracks.js";
import { AUDIO_SLOT_TEMPLATE } from "./audio-slot-template.js";

export type GraftError = { code: "NO_SUCH_TRACK" | "NOT_AN_AUDIO_TRACK" | "DONOR_INVALID"; message: string };

const TRACK_FOLDER = 0x40000;
const EVENT_SIZE = 80;
const TAIL_SIZE = 16;
const END_OF_CHAIN = 0xffffffff;
const REGION_NAME_AT = 0x4a;

const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const withGroup = (header: Uint8Array, group: number) => {
  const h = Uint8Array.from(header);
  view(h).setUint32(8, group, true);
  return h;
};
const evaw = (p: Uint8Array) => {
  for (let i = 0; i + 4 <= p.length; i++) if (p[i] === 0x45 && p[i + 1] === 0x56 && p[i + 2] === 0x41 && p[i + 3] === 0x57) return i;
  return -1;
};

/** A fresh identity: the 16 bytes GarageBand keeps per region (4 @+0x2A, then 4 and 8 bytes after the name). */
function newIdentity(region: Uint8Array): Uint8Array {
  const p = Uint8Array.from(region);
  const length = view(p).getUint16(REGION_NAME_AT, true);
  const nameEnd = REGION_NAME_AT + 2 + length + (length & 1);
  p.set(randomBytes(4), 0x2a);
  p.set(randomBytes(4), nameEnd + 0x56);
  p.set(randomBytes(8), nameEnd + 0x5e);
  return p;
}

const listing = (tracks: ReturnType<typeof visibleTracks>) => tracks.map((t) => `${t.number} (${t.name})`).join(", ");

/** `tracks`: one visible audio track number per new slot (a track may take several). */
export function graftAudioSlots(pd: ProjectData, tracks: readonly number[]): Result<ProjectData, GraftError> {
  const visible = visibleTracks(pd);
  const audioTracks = visible.filter((t) => t.kind === "audio");
  for (const number of tracks) {
    const track = visible.find((t) => t.number === number);
    if (!track) return err({ code: "NO_SUCH_TRACK", message: `the project has no track ${number}; its tracks: ${listing(visible)}` });
    if (track.kind !== "audio") {
      return err({ code: "NOT_AN_AUDIO_TRACK", message: `track ${number} (${track.name}) is an instrument track; audio tracks: ${listing(audioTracks) || "none"}` });
    }
  }
  const records = pd.records.slice();
  const files = records.filter((r) => r.tag === "AuFl");
  if (files.some((r, i) => groupOf(r.header) !== i * REGION_GROUP)) return err({ code: "DONOR_INVALID", message: "the project's audio files are not numbered 0, 1, 2…" });
  const listAt = records.findIndex((r) => r.tag === "EvSq" && groupOf(r.header) === TRACK_FOLDER && (r.payload[0] === 0x20 || r.payload[0] === 0x24));
  if (listAt < 0) return err({ code: "DONOR_INVALID", message: "the project has no track list (placements)" });

  const n0 = files.length;
  const events: Uint8Array[] = [];
  tracks.forEach((number, k) => {
    const n = n0 + k;
    const strip = visible.find((t) => t.number === number)!.strip;
    const file: BandRecord = { tag: "AuFl", header: withGroup(bytes(AUDIO_SLOT_TEMPLATE.file.header), n * REGION_GROUP), payload: bytes(AUDIO_SLOT_TEMPLATE.file.payload) };
    const region: BandRecord = { tag: "AuRg", header: withGroup(bytes(AUDIO_SLOT_TEMPLATE.region.header), n * REGION_GROUP), payload: newIdentity(bytes(AUDIO_SLOT_TEMPLATE.region.payload)) };
    const meta: BandRecord = { tag: "GenM", header: withGroup(bytes(AUDIO_SLOT_TEMPLATE.meta.header), (n + 1) * REGION_GROUP), payload: bytes(AUDIO_SLOT_TEMPLATE.meta.payload) };
    view(meta.payload).setUint32(0x0c, n * 4, true);
    const lastRegion = records.map((r) => r.tag).lastIndexOf("AuRg");
    records.splice((lastRegion >= 0 ? lastRegion : records.map((r) => r.tag).lastIndexOf("TxSt")) + 1, 0, file, region);
    records.splice(records.map((r) => r.tag).lastIndexOf("GenM") + 1, 0, meta);
    const ev = bytes(AUDIO_SLOT_TEMPLATE.placement);
    view(ev).setUint32(0x10, strip, true);
    ev[0x14] = number;
    view(ev).setUint32(0x2c, n * 4, true);
    events.push(ev);
    const trak = records.findIndex((r) => r.tag === "Trak" && groupOf(r.header) === TRACK_FOLDER && r.payload.length >= 12 && view(r.payload).getUint32(8, true) === strip);
    if (trak >= 0) {
      const payload = Uint8Array.from(records[trak]!.payload);
      view(payload).setUint32(0, TRACK_HOLDS_REGIONS, true);
      records[trak] = { ...records[trak]!, payload };
    }
  });

  // relink the file chain over all files, old and new
  const all = records.map((r, i) => [r, i] as const).filter(([r]) => r.tag === "AuFl");
  all.forEach(([r, i], k) => {
    const payload = Uint8Array.from(r.payload);
    const e = evaw(payload);
    payload[e + 0x38] = k + 1;
    view(payload).setUint32(e + 0x3e, k + 1 < all.length ? (k + 1) * 4 : END_OF_CHAIN, true);
    records[i] = { ...r, payload };
  });

  const listIndex = records.findIndex((r) => r.tag === "EvSq" && groupOf(r.header) === TRACK_FOLDER && (r.payload[0] === 0x20 || r.payload[0] === 0x24));
  const list = records[listIndex]!.payload;
  const grown = new Uint8Array(list.length + EVENT_SIZE * events.length);
  grown.set(list.subarray(0, list.length - TAIL_SIZE), 0);
  events.forEach((ev, k) => grown.set(ev, list.length - TAIL_SIZE + k * EVENT_SIZE));
  grown.set(list.subarray(list.length - TAIL_SIZE), grown.length - TAIL_SIZE);
  records[listIndex] = { ...records[listIndex]!, payload: grown };
  return ok({ ...pd, records });
}
