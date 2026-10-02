// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { renderSong } from "./render.js";
import { parseSong, type Song } from "./schema.js";

const song = (input: object): Song => {
  const r = parseSong(input);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

const base = {
  title: "Test",
  tempo: 132,
  humanize: "off",
  sections: [{ name: "intro", bars: 2 }, { name: "drop", bars: 4 }],
};

describe("renderSong", () => {
  it("maps tempo, PPQ 480, track names, channels (drums = 10) and style programs", () => {
    const out = renderSong(song({ ...base, style: "orbit-ambient", tracks: [
      { name: "Drums", role: "drums", parts: { drop: { grid: { kick: "x...x...x...x..." } } } },
      { name: "Strings", role: "pad", parts: { intro: { chords: "Fm", style: "sustain" } } },
    ] }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value).toMatchObject({ ppq: 480, tempoBpm: 132, timeSignature: [4, 4] });
    expect(out.value.tracks.map((t) => [t.name, t.channel, t.program])).toEqual([["Drums", 10, 24], ["Strings", 1, 48]]);
  });

  it("places a part at its section's start and loops its pattern to fill the section", () => {
    const out = renderSong(song({ ...base, tracks: [
      { name: "Drums", role: "drums", parts: { drop: { grid: { kick: "x...x...x...x..." } } } },
    ] }));
    if (!out.ok) throw new Error(out.error.message);
    const kicks = out.value.tracks[0]!.notes;
    expect(kicks).toHaveLength(16); // 4 per bar × 4 bars of "drop"
    expect(kicks[0]).toEqual({ pitch: 36, startTick: 2 * 4 * 480, durationTicks: 120, velocity: 100 }); // drop starts at bar 3
  });

  it("applies per-voice grid levels (kick -6 dB → velocity 71) without touching other voices", () => {
    const out = renderSong(song({ ...base, tracks: [
      { name: "Drums", role: "drums", parts: { drop: { grid: { kick: "x...", hat: "..x." }, levels: { kick: -6 } } } },
    ] }));
    if (!out.ok) throw new Error(out.error.message);
    const byPitch = (p: number) => out.value.tracks[0]!.notes.filter((n) => n.pitch === p).map((n) => n.velocity);
    expect(new Set(byPitch(36))).toEqual(new Set([71]));
    expect(new Set(byPitch(42))).toEqual(new Set([100]));
  });

  it("renders chord parts with the role's style (offbeat bass on F2 for Fm)", () => {
    const out = renderSong(song({ ...base, tracks: [
      { name: "Bass", role: "bass", parts: { intro: { chords: "Fm", style: "offbeat" } } },
    ] }));
    if (!out.ok) throw new Error(out.error.message);
    const notes = out.value.tracks[0]!.notes;
    expect(notes).toHaveLength(8); // 4 per bar × 2 bars of "intro" (1-bar progression looped)
    expect(notes[0]).toMatchObject({ pitch: 41, startTick: 240 });
  });

  it("renders melody notes, looping a 1-bar phrase over the section", () => {
    const out = renderSong(song({ ...base, tracks: [
      { name: "Lead", role: "lead", parts: { intro: { notes: "c5 ~ e5 ~" } } },
    ] }));
    if (!out.ok) throw new Error(out.error.message);
    expect(out.value.tracks[0]!.notes.map((n) => [n.pitch, n.startTick])).toEqual([
      [72, 0], [76, 960], [72, 1920], [76, 2880],
    ]);
  });

  it("truncates a pattern longer than its section instead of spilling into the next", () => {
    const out = renderSong(song({ ...base, tracks: [
      { name: "Lead", role: "lead", parts: { intro: { notes: "c5 | d5 | e5" } } }, // 3 bars into a 2-bar section
    ] }));
    if (!out.ok) throw new Error(out.error.message);
    expect(out.value.tracks[0]!.notes.map((n) => n.pitch)).toEqual([72, 74]);
  });

  it("reports a bad pattern with the track and section that contain it", () => {
    const out = renderSong(song({ ...base, tracks: [
      { name: "Lead", role: "lead", parts: { intro: { notes: "c5 q9" } } },
    ] }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatchObject({ code: "RENDER_FAILED", path: "tracks.Lead.parts.intro" });
  });
});
