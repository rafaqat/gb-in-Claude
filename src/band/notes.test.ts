// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodeNoteList, encodeNote, encodeNoteList, type Note } from "./notes.js";

const list = (name: string) => new Uint8Array(readFileSync(fileURLToPath(new URL(`../../test/fixtures/band/${name}.evsq`, import.meta.url))));

describe("decodeNoteList", () => {
  it("decodes a GarageBand region's events: the program change, then 32-byte notes (pitch, velocity, start, length)", () => {
    const events = decodeNoteList(list("notes-cal-ch1"));
    expect(events[0]).toEqual({ kind: "program", channel: 0, tick: 0, program: 0 });
    const notes = events.filter((e) => e.kind === "note");
    expect(notes).toHaveLength(20);
    expect(notes[0]).toEqual({ kind: "note", channel: 0, tick: 0, pitch: 48, velocity: 96, length: 3720 });
  });
});

describe("encodeNote", () => {
  it("writes a note exactly as GarageBand does, except the fine-velocity byte (+0x0a), which new notes leave 0", () => {
    const fixtureNote = list("notes-cal-ch1").slice(16, 48);       // the first note, after the 16-byte program change
    const expected = fixtureNote.slice();
    expected[0x0a] = 0;
    expect(Buffer.from(encodeNote({ channel: 0, tick: 0, pitch: 48, velocity: 96, length: 3720 })).equals(Buffer.from(expected))).toBe(true);
  });

  it("puts the MIDI channel in the marker's low nibble (the Bassoon region is channel 3)", () => {
    const fixtureNote = list("notes-williams-ch4").slice(16, 48);
    const expected = fixtureNote.slice();
    expected[0x0a] = 0;
    expect(Buffer.from(encodeNote({ channel: 3, tick: 15368, pitch: 48, velocity: 86, length: 458 })).equals(Buffer.from(expected))).toBe(true);
  });
});

describe("encodeNoteList", () => {
  it("rebuilds a region's whole list: program change, notes in time order, tail (byte-for-byte except fine velocity)", () => {
    const fixture = list("notes-cal-ch1");
    const notes = decodeNoteList(fixture).flatMap((e) => (e.kind === "note" ? [{ ...e } as Note & { kind?: string }] : []))
      .map(({ kind: _k, ...n }) => n);
    const expected = fixture.slice();
    for (let at = 16; at < expected.length - 16; at += 32) expected[at + 0x0a] = 0;
    const shuffled = [...notes].reverse();
    expect(Buffer.from(encodeNoteList({ channel: 0, program: 0 }, shuffled)).equals(Buffer.from(expected))).toBe(true);
  });
});
