// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { parseSong } from "./schema.js";
import { bandPlan } from "./band-plan.js";

const song = (over: object = {}) => {
  const r = parseSong({
    title: "Orbit", tempo: 120, sections: [{ name: "intro", bars: 4 }, { name: "chorus", bars: 8 }],
    tracks: [
      { name: "Pad", role: "pad", parts: { intro: { chords: "Dm", style: "sustain" } } },
      { name: "Vox", role: "lead", parts: {}, donorTrack: 2, audio: [{ wav: "stems/vox.wav", section: "chorus", bar: 2, beat: 3 }, { wav: "stems/hit.wav", section: "intro" }] },
    ],
    ...over,
  });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

describe("bandPlan: Song JSON audio clips → gb_band build's audio list", () => {
  it("turns section-relative clips into absolute bar and beat on the donor track, in song order", () => {
    expect(bandPlan(song())).toEqual({ ok: true, value: { audio: [
      { wav: "stems/hit.wav", bar: 1, beat: 1, track: 2 },
      { wav: "stems/vox.wav", bar: 6, beat: 3, track: 2 },
    ] } });
  });
});

describe("bandPlan: only plans gb_band build can accept", () => {
  const clip = (over: object) => ({ wav: "stems/x.wav", section: "chorus", ...over });
  const voxTrack = (audio: object[], name = "Vox", donorTrack = 2) => ({ name, role: "lead", parts: {}, donorTrack, audio });
  it.each([
    ["a beat past gb_band's 4.999", { tracks: [voxTrack([clip({ beat: 4.9995 })])] }],
    ["a bar past gb_band's 9999", { sections: [...Array.from({ length: 40 }, (_, i) => ({ name: `s${i}`, bars: 256 })), { name: "chorus", bars: 8 }],
      tracks: [voxTrack([clip({ bar: 8 })])] }],
    ["more clips than gb_band's 64", { tracks: [voxTrack(Array.from({ length: 40 }, () => clip({}))), voxTrack(Array.from({ length: 40 }, () => clip({})), "Vox2", 3)] }],
  ])("refuses %s (NOT_SUPPORTED)", (_why, over) => {
    expect(bandPlan(song(over))).toMatchObject({ ok: false, error: { code: "NOT_SUPPORTED" } });
  });
});
