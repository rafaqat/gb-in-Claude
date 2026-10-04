// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { writeSmf } from "./smf.js";

const bytes = (u8: Uint8Array): number[] => Array.from(u8);
const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));
const CONDUCTOR = 8 + 19; // tempo + time signature + end

/** The body of the first instrument track (after its MTrk header and the name event). */
function firstTrackBody(out: ReturnType<typeof writeSmf>, nameLength: number): number[] {
  if (!out.ok) throw new Error(out.error.message);
  return bytes(out.value).slice(14 + CONDUCTOR + 8 + 4 + nameLength);
}

describe("writeSmf: pitch bend (M11; honoured by GarageBand, probe 2026-10-04)", () => {
  it("writes 14-bit bends (0xE0, LSB, MSB, centre 8192) and puts a bend before a note-on at the same tick", () => {
    const out = writeSmf({
      ppq: 480, tempoBpm: 120, timeSignature: [4, 4],
      tracks: [{ name: "Fl", channel: 2,
        notes: [{ pitch: 69, startTick: 0, durationTicks: 480, velocity: 90 }, { pitch: 71, startTick: 480, durationTicks: 480, velocity: 90 }],
        bends: [{ tick: 240, value: 4096 }, { tick: 480, value: 0 }] }],
    });
    expect(firstTrackBody(out, 2)).toEqual([
      0x00, 0x91, 69, 90, // note on A4
      0x81, 0x70, 0xe1, 0x00, 0x60, // +240: bend +4096 → 12288 = MSB 0x60, LSB 0x00
      0x81, 0x70, 0x81, 69, 0, // +240: note off A4
      0x00, 0xe1, 0x00, 0x40, // bend reset (8192) before the next note-on
      0x00, 0x91, 71, 90,
      0x83, 0x60, 0x81, 71, 0,
      0x00, 0xff, 0x2f, 0x00,
    ]);
  });
});

describe("writeSmf: bend range (RPN 0)", () => {
  it("writes RPN 0 = bendRange semitones after the program change, then nulls the RPN", () => {
    const out = writeSmf({
      ppq: 480, tempoBpm: 120, timeSignature: [4, 4],
      tracks: [{ name: "Fl", channel: 1, program: 73, bendRange: 12, notes: [] }],
    });
    expect(firstTrackBody(out, 2)).toEqual([
      0x00, 0xc0, 73,
      0x00, 0xb0, 101, 0, 0x00, 0xb0, 100, 0, // select RPN 0 (pitch-bend sensitivity)
      0x00, 0xb0, 6, 12, 0x00, 0xb0, 38, 0, // 12 semitones, 0 cents
      0x00, 0xb0, 101, 127, 0x00, 0xb0, 100, 127, // RPN null: later CC6 cannot change it by accident
      0x00, 0xff, 0x2f, 0x00,
    ]);
  });
});

describe("writeSmf: channel pressure (honoured by synth patches, probe 2)", () => {
  it("writes 0xD0 events with one data byte", () => {
    const out = writeSmf({
      ppq: 480, tempoBpm: 120, timeSignature: [4, 4],
      tracks: [{ name: "Sy", channel: 4, notes: [], pressure: [{ tick: 480, value: 100 }] }],
    });
    expect(firstTrackBody(out, 2)).toEqual([0x83, 0x60, 0xd3, 100, 0x00, 0xff, 0x2f, 0x00]);
  });
});

describe("writeSmf: conductor — tempo map, key signature, markers", () => {
  const conductor = (out: ReturnType<typeof writeSmf>) => {
    if (!out.ok) throw new Error(out.error.message);
    const all = bytes(out.value);
    const len = (all[18]! << 24) | (all[19]! << 16) | (all[20]! << 8) | all[21]!;
    return all.slice(22, 22 + len);
  };
  it("writes tempo changes after the initial tempo (GarageBand honours them, probe 2026-10-04)", () => {
    const out = writeSmf({ ppq: 480, tempoBpm: 120, timeSignature: [4, 4], tracks: [], tempoMap: [{ tick: 1920, bpm: 60 }] });
    expect(conductor(out)).toEqual([
      0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20,
      0x00, 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08,
      0x8f, 0x00, 0xff, 0x51, 0x03, 0x0f, 0x42, 0x40, // +1920: 1 000 000 µs/quarter = 60 BPM
      0x00, 0xff, 0x2f, 0x00,
    ]);
  });
  it("writes a key signature (sharps/flats, minor) and section markers", () => {
    const out = writeSmf({ ppq: 480, tempoBpm: 120, timeSignature: [4, 4], tracks: [],
      keySignature: { accidentals: 1, minor: true }, markers: [{ tick: 0, text: "aalap" }, { tick: 1920, text: "mukhda" }] });
    expect(conductor(out)).toEqual([
      0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20,
      0x00, 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08,
      0x00, 0xff, 0x59, 0x02, 0x01, 0x01, // E minor: 1 sharp, minor
      0x00, 0xff, 0x06, 0x05, ...ascii("aalap"),
      0x8f, 0x00, 0xff, 0x06, 0x06, ...ascii("mukhda"),
      0x00, 0xff, 0x2f, 0x00,
    ]);
  });
});
