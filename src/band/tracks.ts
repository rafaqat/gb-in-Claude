// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/**
 * The tracks GarageBand shows, read from ProjectData (M11b; checked on GarageBand 10.4.14 saves):
 * the visible tracks are the `Trak` records of group 0x40000 whose first u32 has low half 0x0001 (0x00140001 once the
 * track holds regions — GarageBand sets that on save — 0x00000001 while it is empty; 3 = not a visible track), in record order; the u32
 * at +8 is the track's channel strip (its `Envi` record is in group strip << 16). In that `Envi`, bit 0x80 of byte 0x60
 * is set for an instrument strip and clear for an audio strip, and the strip's name is [u8 length @0x9E][ASCII @0xA0].
 * Audio placements carry their track's strip at +0x10 (eval/m11b/BAND-FORMAT.md).
 */
import type { ProjectData } from "./projectdata.js";
import { groupOf } from "./audio.js";

export type VisibleTrack = { number: number; strip: number; kind: "audio" | "instrument"; name: string };

const TRACK_FOLDER = 0x40000;
/** Low half of a visible track's first u32; the high half 0x0014 marks a track that holds regions. */
const VISIBLE = 0x0001;
export const TRACK_HOLDS_REGIONS = 0x00140001;
const KIND_BYTE = 0x60;
const NAME_LENGTH = 0x9e;
const NAME_AT = 0xa0;

const u32 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at, true);

export function visibleTracks(pd: ProjectData): VisibleTrack[] {
  const strips = new Map(pd.records.filter((r) => r.tag === "Envi").map((r) => [groupOf(r.header) >>> 16, r.payload]));
  return pd.records
    .filter((r) => r.tag === "Trak" && groupOf(r.header) === TRACK_FOLDER && r.payload.length >= 12 && (u32(r.payload, 0) & 0xffff) === VISIBLE)
    .map((r, i) => {
      const strip = u32(r.payload, 8);
      const envi = strips.get(strip);
      const kind = envi && envi.length > KIND_BYTE && (envi[KIND_BYTE]! & 0x80) === 0 ? "audio" as const : "instrument" as const;
      const length = envi && envi.length > NAME_LENGTH ? envi[NAME_LENGTH]! : 0;
      const name = envi ? new TextDecoder("latin1").decode(envi.subarray(NAME_AT, NAME_AT + length)) : "";
      return { number: i + 1, strip, kind, name };
    });
}
