// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/**
 * MIDI regions in GarageBand ProjectData (checked on GarageBand 10.4.14 MIDI imports):
 * a region is an MSeq record — name [u16 length][ASCII][pad to even] @+0x10, length in ticks 0x3C bytes after the
 * name — paired with a note list (an EvSq with the same record group). The arrange list's 0x20 placement event points
 * at it: placement u32 @+0x20, shifted left 16 bits, is the region's group.
 */
import type { ProjectData } from "./projectdata.js";
import { groupOf } from "./audio.js";
import { decodeNoteList, encodeNoteList, type Note } from "./notes.js";

const NAME_AT = 0x10;
const LENGTH_AFTER_NAME = 0x3c;

export type MidiRegion = { record: number; noteRecord: number; name: string; group: number; length: number; channel: number; program: number; notes: Note[] };

const nameEnd = (p: Uint8Array) => {
  const length = new DataView(p.buffer, p.byteOffset, p.byteLength).getUint16(NAME_AT, true);
  return { length, end: NAME_AT + 2 + length + (length & 1) };
};

const isNoteList = (p: Uint8Array) => p.length > 16 && ((p[0]! & 0xf0) === 0xc0 || (p[0]! & 0xf0) === 0x90);

export function midiRegions(pd: ProjectData): MidiRegion[] {
  const out: MidiRegion[] = [];
  // each group's first note list, indexed once: a lookup per MSeq would be quadratic on a big donor
  const noteLists = new Map<number, number>();
  pd.records.forEach((n, i) => {
    if (n.tag !== "EvSq" || !isNoteList(n.payload)) return;
    const group = groupOf(n.header);
    if (!noteLists.has(group)) noteLists.set(group, i);
  });
  pd.records.forEach((r, record) => {
    if (r.tag !== "MSeq") return;
    const group = groupOf(r.header);
    const noteRecord = noteLists.get(group);
    if (noteRecord === undefined) return;
    const { length: chars, end } = nameEnd(r.payload);
    const events = decodeNoteList(pd.records[noteRecord]!.payload);
    const program = events.find((e) => e.kind === "program");
    const notes = events.flatMap((e) => (e.kind === "note" ? [{ channel: e.channel, tick: e.tick, pitch: e.pitch, velocity: e.velocity, length: e.length }] : []));
    out.push({
      record, noteRecord, group,
      name: new TextDecoder("latin1").decode(r.payload.subarray(NAME_AT + 2, NAME_AT + 2 + chars)),
      length: new DataView(r.payload.buffer, r.payload.byteOffset, r.payload.byteLength).getUint32(end + LENGTH_AFTER_NAME, true),
      channel: program?.kind === "program" ? program.channel : (notes[0]?.channel ?? 0),
      program: program?.kind === "program" ? program.program : 0,
      notes,
    });
  });
  return out;
}

/** A copy of `pd` with `region`'s note list rebuilt (its channel kept) and its length set; nothing else changes. */
export function withMidiNotes(pd: ProjectData, region: MidiRegion, content: { program: number; notes: readonly Note[]; length: number }): ProjectData {
  const records = pd.records.slice();
  const host = records[region.record]!;
  const payload = host.payload.slice();
  new DataView(payload.buffer).setUint32(nameEnd(payload).end + LENGTH_AFTER_NAME, content.length, true);
  records[region.record] = { ...host, payload };
  const list = records[region.noteRecord]!;
  const notes = content.notes.map((n) => ({ ...n, channel: region.channel }));
  records[region.noteRecord] = { ...list, payload: encodeNoteList({ channel: region.channel, program: content.program }, notes) };
  return { ...pd, records };
}
