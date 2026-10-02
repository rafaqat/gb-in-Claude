// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { vlq, writeSmf } from "./smf.js";

const bytes = (u8: Uint8Array): number[] => Array.from(u8);
const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

describe("writeSmf: header + conductor track", () => {
  it("writes a Type-1 header and a conductor track with tempo, time signature, end-of-track", () => {
    const out = writeSmf({ ppq: 480, tempoBpm: 120, timeSignature: [4, 4], tracks: [] });
    expect(out.ok && bytes(out.value)).toEqual([
      ...ascii("MThd"), 0, 0, 0, 6, 0, 1, 0, 1, 0x01, 0xe0, // format 1, 1 track, PPQ 480
      ...ascii("MTrk"), 0, 0, 0, 19,
      0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, // tempo: 500000 µs/quarter = 120 BPM
      0x00, 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08, // 4/4, 24 clocks/click, 8 32nds/quarter
      0x00, 0xff, 0x2f, 0x00, // end of track
    ]);
  });
});

describe("writeSmf: instrument tracks", () => {
  it("writes name, program change and note on/off with delta times; header counts the track", () => {
    const out = writeSmf({
      ppq: 480, tempoBpm: 120, timeSignature: [4, 4],
      tracks: [{ name: "Bass", channel: 1, program: 39,
        notes: [{ pitch: 41, startTick: 240, durationTicks: 144, velocity: 92 }] }],
    });
    if (!out.ok) throw new Error(out.error.message);
    const all = bytes(out.value);
    expect(all.slice(10, 12)).toEqual([0, 2]); // conductor + 1 track
    const track = all.slice(14 + 8 + 19); // skip header (14) + conductor chunk (8 + 19)
    expect(track).toEqual([
      ...ascii("MTrk"), 0, 0, 0, 25, // 8 name + 3 program + 5 on + 5 off + 4 end
      0x00, 0xff, 0x03, 0x04, ...ascii("Bass"), // track name → GarageBand region name
      0x00, 0xc0, 39, // program change, channel 1 → Taureg Moon Bass
      0x81, 0x70, 0x90, 41, 92, // +240 ticks: note on F2
      0x81, 0x10, 0x80, 41, 0, // +144 ticks: note off
      0x00, 0xff, 0x2f, 0x00,
    ]);
  });
});

describe("writeSmf: controller changes", () => {
  it("writes CC events on the track's channel, ordered with notes; note-offs before CCs before note-ons at a tick", () => {
    const out = writeSmf({
      ppq: 480, tempoBpm: 120, timeSignature: [4, 4],
      tracks: [{ name: "Lead", channel: 3, notes: [{ pitch: 72, startTick: 0, durationTicks: 480, velocity: 90 }],
        controllers: [{ tick: 240, controller: 1, value: 40 }, { tick: 480, controller: 1, value: 0 }] }],
    });
    if (!out.ok) throw new Error(out.error.message);
    const track = bytes(out.value).slice(14 + 8 + 19 + 8);
    expect(track).toEqual([
      0x00, 0xff, 0x03, 0x04, ...ascii("Lead"),
      0x00, 0x92, 72, 90, // note on, channel 3
      0x81, 0x70, 0xb2, 1, 40, // +240: CC1 = 40 (vibrato in)
      0x81, 0x70, 0x82, 72, 0, // +240: note off first …
      0x00, 0xb2, 1, 0, // … then CC1 reset
      0x00, 0xff, 0x2f, 0x00,
    ]);
  });

  it("rejects controller numbers or values above 127", () => {
    const out = writeSmf({ ppq: 480, tempoBpm: 120, timeSignature: [4, 4],
      tracks: [{ name: "Lead", channel: 3, notes: [], controllers: [{ tick: 0, controller: 128, value: 0 }] }] });
    expect(out.ok).toBe(false);
  });
});

describe("writeSmf: invariants (refuse, never write a file that loses notes)", () => {
  const song = (notes: { pitch: number; startTick: number; durationTicks: number; velocity: number }[]) => ({
    ppq: 480, tempoBpm: 120, timeSignature: [4, 4] as [number, number],
    tracks: [{ name: "Pad", channel: 2, notes }],
  });

  it("rejects overlapping notes of the same pitch on a track (MIDI would swallow one)", () => {
    const out = writeSmf(song([
      { pitch: 60, startTick: 0, durationTicks: 500, velocity: 80 },
      { pitch: 60, startTick: 480, durationTicks: 480, velocity: 80 },
    ]));
    expect(out).toEqual({ ok: false, error: {
      code: "INVALID_SMF_INPUT",
      message: 'track "Pad": overlapping notes on pitch 60 at tick 480',
    } });
  });

  const base = { pitch: 60, startTick: 0, durationTicks: 480, velocity: 80 };
  it.each([
    ["channel 0", { channel: 0 }, {}],
    ["channel 17", { channel: 17 }, {}],
    ["program 128", { program: 128 }, {}],
    ["pitch 128", {}, { pitch: 128 }],
    ["velocity 0 (that is a note-off)", {}, { velocity: 0 }],
    ["velocity 128", {}, { velocity: 128 }],
    ["negative start", {}, { startTick: -1 }],
    ["zero duration", {}, { durationTicks: 0 }],
    ["fractional tick", {}, { startTick: 0.5 }],
    ["name with control character", { name: "Lead\n" }, {}],
    ["name with non-ASCII", { name: "Lead ♯" }, {}],
    ["empty name", { name: "" }, {}],
  ])("rejects %s", (_label, trackPatch, notePatch) => {
    const out = writeSmf({
      ppq: 480, tempoBpm: 120, timeSignature: [4, 4],
      tracks: [{ name: "Pad", channel: 2, notes: [{ ...base, ...notePatch }], ...trackPatch }],
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("INVALID_SMF_INPUT");
  });

  it.each([["tempo 0", { tempoBpm: 0 }], ["tempo 1000", { tempoBpm: 1000 }], ["ppq 0", { ppq: 0 }],
    ["time signature 4/3", { timeSignature: [4, 3] }]])("rejects song-level %s", (_label, patch) => {
    const out = writeSmf({ ppq: 480, tempoBpm: 120, timeSignature: [4, 4], tracks: [], ...patch } as never);
    expect(out.ok).toBe(false);
  });

  it("allows back-to-back repeats of the same pitch (off and on at the same tick)", () => {
    const out = writeSmf(song([
      { pitch: 60, startTick: 0, durationTicks: 480, velocity: 80 },
      { pitch: 60, startTick: 480, durationTicks: 480, velocity: 80 },
    ]));
    expect(out.ok).toBe(true);
  });
});

describe("vlq (MIDI variable-length quantity)", () => {
  it.each([
    [0, [0x00]],
    [0x7f, [0x7f]],
    [0x80, [0x81, 0x00]],
    [0x2000, [0xc0, 0x00]],
    [0x3fff, [0xff, 0x7f]],
    [0x0fffffff, [0xff, 0xff, 0xff, 0x7f]],
  ])("encodes %i", (n, bytes) => {
    expect(vlq(n)).toEqual(bytes);
  });
});
