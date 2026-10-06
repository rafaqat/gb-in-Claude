// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { writeSmf } from "./smf.js";
import { readSmfSummary } from "./smf-read.js";

describe("readSmfSummary", () => {
  it("reads tempo and the names of tracks that have notes, in order", () => {
    const smf = writeSmf({
      ppq: 480, tempoBpm: 126, timeSignature: [4, 4],
      tracks: [
        { name: "Drums", channel: 10, program: 24, notes: [{ pitch: 36, startTick: 0, durationTicks: 120, velocity: 100 }] },
        { name: "Empty", channel: 1, notes: [] },
        { name: "Strings", channel: 2, program: 48, notes: [{ pitch: 60, startTick: 0, durationTicks: 480, velocity: 80 }] },
      ],
    });
    if (!smf.ok) throw new Error(smf.error.message);
    expect(readSmfSummary(smf.value)).toEqual({ ok: true, value: { tempoBpm: 126, trackNames: ["Drums", "Strings"], programs: [24, 48] } });
  });

  it("rejects bytes that are not a MIDI file", () => {
    expect(readSmfSummary(Buffer.from("hello")).ok).toBe(false);
  });
});

// security review 2026-10-06 (C1): readVlq read past the buffer (undefined < 0x80 is false) and looped for ever; a
// track length past the file's end was never checked. A crafted .mid hung the whole server in open_midi.
describe("readSmfSummary on truncated or lying files", () => {
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 1, 0x01, 0xe0];
  it("a track whose length runs past the end of the file is an error, not a hang", () => {
    const b = Uint8Array.from([...header, 0x4d, 0x54, 0x72, 0x6b, 0x7f, 0xff, 0xff, 0xff, 0x80]);
    expect(readSmfSummary(b)).toMatchObject({ ok: false });
  });
  it("a variable-length number that never ends is an error", () => {
    const body = [0x00, 0xff, 0x03, 0x81, 0x81, 0x81, 0x81, 0x81]; // a meta length with five continuation bytes
    const b = Uint8Array.from([...header, 0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, body.length, ...body]);
    expect(readSmfSummary(b)).toMatchObject({ ok: false });
  });
  it("a meta event whose text runs past the track is an error", () => {
    const body = [0x00, 0xff, 0x03, 0x7f, 0x41];
    const b = Uint8Array.from([...header, 0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, body.length, ...body]);
    expect(readSmfSummary(b)).toMatchObject({ ok: false });
  });
});
