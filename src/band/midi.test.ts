// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseProjectData, type ProjectData } from "./projectdata.js";
import { midiRegions, withMidiNotes } from "./midi.js";

const project = (name: string): ProjectData => {
  const r = parseProjectData(new Uint8Array(readFileSync(fileURLToPath(new URL(`../../test/fixtures/band/${name}.projectdata`, import.meta.url)))));
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

describe("midiRegions", () => {
  it("finds each MIDI region of a GarageBand MIDI import: name, group, length in ticks, channel, program and notes", () => {
    const regions = midiRegions(project("seed-keys-bass"));
    expect(regions.map(({ name, group, length, channel, program, notes }) => ({ name, group, length, channel, program, notes: notes.length }))).toEqual([
      { name: "Keys", group: 0x180000, length: 7680, channel: 0, program: 0, notes: 6 },
      { name: "Bass", group: 0x200000, length: 7680, channel: 1, program: 33, notes: 2 },
    ]);
  });
});

describe("withMidiNotes", () => {
  it("rewrites one region's notes, program and length; every other record stays byte-identical", () => {
    const pd = project("seed-keys-bass");
    const keys = midiRegions(pd)[0]!;
    const notes = [
      { channel: 0, tick: 0, pitch: 62, velocity: 80, length: 480 },
      { channel: 0, tick: 7680, pitch: 69, velocity: 100, length: 3840 },
    ];
    const out = withMidiNotes(pd, keys, { program: 4, notes, length: 15360 });
    const again = midiRegions(out)[0]!;
    expect({ name: again.name, program: again.program, length: again.length, notes: again.notes }).toEqual({ name: "Keys", program: 4, length: 15360, notes });
    const changed = out.records.flatMap((r, i) => (Buffer.from(r.payload).equals(Buffer.from(pd.records[i]!.payload)) ? [] : [i]));
    expect(changed.sort((a, b) => a - b)).toEqual([keys.record, keys.noteRecord].sort((a, b) => a - b));
  });
});

describe("midiRegions on a big donor", () => {
  it("stays linear: 20 000 MSeq records without note lists are read in well under a second", () => {
    const pd = project("seed-keys-bass");
    const mseq = pd.records.find((r) => r.tag === "MSeq")!;
    const header = mseq.header.slice();
    new DataView(header.buffer, header.byteOffset).setUint32(8, 0xeeee0000, true); // the group (header +8): no note list has it, the slow case
    const records = [...pd.records, ...Array.from({ length: 20_000 }, () => ({ ...mseq, header }))];
    const started = performance.now();
    const regions = midiRegions({ ...pd, records });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(regions.map((r) => r.name)).toEqual(midiRegions(pd).map((r) => r.name));
  });
});
