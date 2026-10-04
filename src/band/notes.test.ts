// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodeNoteList, encodeNote, encodeNoteList, type Note, encodeController, encodeBend } from "./notes.js";

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

describe("controller and pitch-bend events (M11; layout read from GarageBand's own save of an imported MIDI file)", () => {
  const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(" ");
  it("a CC: status|channel, tick +38400 at +4, value at +0x0B (second data byte), controller at +0x0C (first)", () => {
    expect(hex(encodeController({ channel: 0, tick: 0, controller: 11, value: 20 }))).toBe("b0 00 00 00 00 96 00 00 00 00 00 14 0b 00 00 01");
  });
  it("value 127 is stored as GarageBand stores it: flag 0x20 at +1 and a full-scale fraction", () => {
    expect(hex(encodeController({ channel: 7, tick: 107544, controller: 64, value: 127 }))).toBe("b7 20 00 00 18 3a 02 00 ff ff ff 7f 40 00 00 01");
  });
  it("a pitch bend: MSB at +0x0B, LSB at +0x0C (centre = 0x40 0x00)", () => {
    expect(hex(encodeBend({ channel: 5, tick: 0, value: 0 }))).toBe("e5 00 00 00 00 96 00 00 00 00 00 40 00 00 00 01");
    expect(hex(encodeBend({ channel: 5, tick: 0, value: 4 })).slice(33, 38)).toBe("40 04");
  });
  it("decodes them back, and a note list interleaves them with the notes in time order", () => {
    const list = encodeNoteList({ channel: 0, program: 73 }, [{ channel: 0, tick: 480, pitch: 69, velocity: 90, length: 960 }],
      { controllers: [{ tick: 0, controller: 11, value: 50 }], bends: [{ tick: 960, value: -4096 }] });
    const events = decodeNoteList(list);
    expect(events.map((e) => e.kind)).toEqual(["program", "controller", "note", "bend"]);
    expect(events[1]).toEqual({ kind: "controller", channel: 0, tick: 0, controller: 11, value: 50 });
    expect(events[3]).toEqual({ kind: "bend", channel: 0, tick: 960, value: -4096 });
  });
});
