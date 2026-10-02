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
