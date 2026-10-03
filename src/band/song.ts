// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/**
 * Song-wide values in GarageBand ProjectData (checked on GarageBand 10.4.14).
 * - Tempo: the tempo-map event list (payload starts 0x60); each 32-byte point holds BPM × 10000 @+0x10.
 * - Song length (GarageBand stops playback and export there): 38400 + ticks at Song +0x180 and +0x43C,
 *   and the song folder — the group-0x40000 MSeq named after the project — holds the ticks 0x3C after its name.
 */
import type { ProjectData } from "./projectdata.js";
import { groupOf } from "./audio.js";

const TEMPO_EVENT = 0x60;

/** The project's tempo in BPM (the tempo map's first point); null if the file has no tempo map. */
export function projectTempo(pd: ProjectData): number | null {
  const map = pd.records.find((r) => r.tag === "EvSq" && r.payload[0] === TEMPO_EVENT);
  if (!map) return null;
  return new DataView(map.payload.buffer, map.payload.byteOffset, map.payload.byteLength).getUint32(0x10, true) / 10000;
}

/** Song length is stored as 38400 + ticks (the tempo/marker origin) at Song +0x180, with a copy at +0x43C. */
const NOTE_ORIGIN = 38400;
const SONG_END_AT = [0x180, 0x43c] as const;

/** The song length in ticks (960 PPQ), from the Song record. */
export function songLength(pd: ProjectData): number {
  const song = pd.records[0]!.payload;
  return new DataView(song.buffer, song.byteOffset, song.byteLength).getUint32(SONG_END_AT[0], true) - NOTE_ORIGIN;
}

const SONG_GROUP = 0x40000;
const FOLDER_NAME_AT = 0x10;
const LENGTH_AFTER_NAME = 0x3c;

const folderLengthAt = (p: Uint8Array) => {
  const chars = new DataView(p.buffer, p.byteOffset, p.byteLength).getUint16(FOLDER_NAME_AT, true);
  return FOLDER_NAME_AT + 2 + chars + (chars & 1) + LENGTH_AFTER_NAME;
};

/** A copy of `pd` whose song is `ticks` long: the Song record's two copies and the song folder's length. */
export function withSongLength(pd: ProjectData, ticks: number): ProjectData {
  const old = songLength(pd);
  const records = pd.records.slice();
  const song = records[0]!.payload.slice();
  for (const at of SONG_END_AT) new DataView(song.buffer).setUint32(at, NOTE_ORIGIN + ticks, true);
  records[0] = { ...records[0]!, payload: song };
  records.forEach((r, i) => {
    if (r.tag !== "MSeq" || groupOf(r.header) !== SONG_GROUP || r.payload.length < folderLengthAt(r.payload) + 4) return;
    const v = new DataView(r.payload.buffer, r.payload.byteOffset, r.payload.byteLength);
    if (v.getUint32(folderLengthAt(r.payload), true) !== old) return;
    const p = r.payload.slice();
    new DataView(p.buffer).setUint32(folderLengthAt(p), ticks, true);
    records[i] = { ...r, payload: p };
  });
  return { ...pd, records };
}
