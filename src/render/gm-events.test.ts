// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { smfSongToEvents } from "./gm-events.js";
import type { SmfSong } from "../midi/smf.js";

describe("smfSongToEvents", () => {
  const song: SmfSong = {
    ppq: 480, tempoBpm: 120, timeSignature: [4, 4],
    tracks: [
      { name: "Bass", channel: 1, program: 39, notes: [{ pitch: 41, startTick: 480, durationTicks: 240, velocity: 90 }],
        controllers: [{ tick: 480, controller: 1, value: 20 }] },
      { name: "Drums", channel: 10, program: 16, notes: [{ pitch: 36, startTick: 0, durationTicks: 120, velocity: 100 }] },
    ],
  };

  it("converts ticks to seconds at the song tempo and emits program changes first", () => {
    const out = smfSongToEvents(song);
    expect(out.events).toEqual([
      { t: 0, bytes: [0xc0, 39] },
      { t: 0, bytes: [0xc9, 16] },
      { t: 0, bytes: [0x99, 36, 100] },
      { t: 0.125, bytes: [0x89, 36, 0] },
      { t: 0.5, bytes: [0xb0, 1, 20] },
      { t: 0.5, bytes: [0x90, 41, 90] },
      { t: 0.75, bytes: [0x80, 41, 0] },
    ]);
  });

  it("reports the duration as the last event time", () => {
    expect(smfSongToEvents(song).duration_s).toBe(0.75);
  });

  it("orders note-offs before controllers before note-ons at the same time (repeated notes re-trigger)", () => {
    const out = smfSongToEvents({ ...song, tracks: [{ name: "L", channel: 2, notes: [
      { pitch: 60, startTick: 0, durationTicks: 480, velocity: 80 },
      { pitch: 60, startTick: 480, durationTicks: 480, velocity: 80 },
    ], controllers: [{ tick: 480, controller: 1, value: 0 }] }] });
    expect(out.events.filter((e) => e.t === 0.5).map((e) => e.bytes[0])).toEqual([0x81, 0xb1, 0x91]);
  });
});

describe("smfSongToEvents: expression (M11)", () => {
  it("plays pitch bends, the RPN bend range and channel pressure; timing follows the tempo map", () => {
    const list = smfSongToEvents({
      ppq: 480, tempoBpm: 120, timeSignature: [4, 4], tempoMap: [{ tick: 960, bpm: 60 }],
      tracks: [{ name: "Fl", channel: 1, program: 73, bendRange: 12,
        notes: [{ pitch: 69, startTick: 0, durationTicks: 1440, velocity: 90 }],
        bends: [{ tick: 480, value: 4096 }], pressure: [{ tick: 1440, value: 64 }] }],
    });
    const find = (status: number) => list.events.find((e) => e.bytes[0] === status);
    expect(list.events.filter((e) => e.bytes[0] === 0xb0 && e.bytes[1] === 6)).toEqual([{ t: 0, bytes: [0xb0, 6, 12] }]);
    expect(find(0xe0)).toEqual({ t: 0.5, bytes: [0xe0, 0x00, 0x60] }); // 120 BPM: 480 ticks = 0.5 s
    expect(find(0xd0)).toEqual({ t: 2, bytes: [0xd0, 64] }); // 960 ticks at 120 (1 s) + 480 ticks at 60 (1 s)
    expect(find(0x80)!.t).toBe(2); // the note-off also follows the tempo change
  });
});
