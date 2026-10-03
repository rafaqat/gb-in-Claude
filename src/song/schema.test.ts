// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { parseSong } from "./schema.js";

const minimal = {
  title: "Ascent",
  tempo: 132,
  sections: [{ name: "intro", bars: 4 }],
  tracks: [{ name: "Bass", role: "bass", parts: { intro: { chords: "Fm | Db", style: "offbeat" } } }],
};

const withTrack = (track: object) => ({ ...minimal, tracks: [track] });

describe("parseSong: part forms per role", () => {
  it("accepts a drum grid part on a drums track", () => {
    const out = parseSong(withTrack({ name: "Drums", role: "drums",
      parts: { intro: { grid: { kick: "x...x...x...x...", hat: "..x...x...x...x." } } } }));
    expect(out.ok).toBe(true);
  });

  it("accepts a melody notes part on a lead track", () => {
    const out = parseSong(withTrack({ name: "Lead", role: "lead", parts: { intro: { notes: "f5 ab5 c6 ~ | eb6@2 c6 ~" } } }));
    expect(out.ok).toBe(true);
  });

  it.each([
    ["grid on a bass track", { name: "Bass", role: "bass", parts: { intro: { grid: { kick: "x..." } } } }],
    ["chords on a drums track", { name: "Drums", role: "drums", parts: { intro: { chords: "Fm", style: "offbeat" } } }],
    ["unknown chord style for the role", { name: "Bass", role: "bass", parts: { intro: { chords: "Fm", style: "arp-up" } } }],
    ["unknown drum voice", { name: "Drums", role: "drums", parts: { intro: { grid: { cowbell2000: "x..." } } } }],
  ])("rejects %s", (_label, track) => {
    const out = parseSong(withTrack(track));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("SONG_INVALID");
  });
});

describe("parseSong: song-wide rules", () => {
  const lead = (name: string) => ({ name, role: "lead", parts: { intro: { notes: "c5" } } });
  it.each([
    ["a part for an unknown section", { tracks: [{ name: "Lead", role: "lead", parts: { chorus: { notes: "c5" } } }] }, "tracks.0.parts.chorus"],
    ["duplicate section names", { sections: [{ name: "intro", bars: 4 }, { name: "intro", bars: 8 }] }, "sections.1.name"],
    ["duplicate track names", { tracks: [lead("Lead"), lead("Lead")] }, "tracks.1.name"],
    ["more than 15 melodic tracks (channels run out)", { tracks: Array.from({ length: 16 }, (_, i) => lead(`L${i}`)) }, "tracks"],
    ["a non-quarter-note time signature", { timeSignature: [6, 8] }, "timeSignature"],
  ])("rejects %s", (_label, patch, path) => {
    const out = parseSong({ ...minimal, ...patch });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.path).toBe(path);
  });
});

describe("parseSong: style, program, humanize", () => {
  it("accepts a known style, a per-track program override, and defaults humanize to natural", () => {
    const out = parseSong({ ...minimal, style: "orbit-ambient",
      tracks: [{ ...minimal.tracks[0], program: 33 }] });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.style).toBe("orbit-ambient");
    expect(out.value.tracks[0]!.program).toBe(33);
    expect(out.value.humanize).toBe("natural");
  });

  it.each([
    ["unknown style", { style: "dubstep-9000" }, "style"],
    ["unknown humanize feel", { humanize: "drunk" }, "humanize"],
    ["program out of range", { tracks: [{ ...minimal.tracks[0], program: 128 }] }, "tracks.0.program"],
  ])("rejects %s", (_label, patch, path) => {
    const out = parseSong({ ...minimal, ...patch });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.path).toBe(path);
  });
});

describe("parseSong: levels", () => {
  it("accepts a track level in dB and per-voice grid levels", () => {
    const out = parseSong({ ...minimal, tracks: [{ name: "Drums", role: "drums", level: -6,
      parts: { intro: { grid: { kick: "x...", hat: "..x." }, levels: { kick: -4 } } } }] });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.tracks[0]!.level).toBe(-6);
  });

  it.each([
    ["track level above +6 dB", { name: "Drums", role: "drums", level: 9, parts: { intro: { grid: { kick: "x..." } } } }, "tracks.0.level"],
    ["track level below -24 dB", { name: "Drums", role: "drums", level: -30, parts: { intro: { grid: { kick: "x..." } } } }, "tracks.0.level"],
    ["a level for a voice the grid does not have", { name: "Drums", role: "drums", parts: { intro: { grid: { kick: "x..." }, levels: { cowbell: -3 } } } }, "tracks.0.parts.intro"],
  ])("rejects %s", (_label, track, path) => {
    const out = parseSong({ ...minimal, tracks: [track] });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.path).toBe(path);
  });
});

describe("parseSong: key", () => {
  it.each(["F minor", "Ab major", "C# minor", "Bb major"])("accepts declared key %j", (key) => {
    const out = parseSong({ ...minimal, key });
    expect(out.ok && out.value.key).toBe(key);
  });

  it.each(["F", "H minor", "F dorian", "minor"])("rejects key %j", (key) => {
    const out = parseSong({ ...minimal, key });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.path).toBe("key");
  });
});

describe("parseSong", () => {
  it("parses a minimal song and fills defaults (4/4, seed 1, no style)", () => {
    const out = parseSong(minimal);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.timeSignature).toEqual([4, 4]);
    expect(out.value.seed).toBe(1);
    expect(out.value.style).toBeUndefined();
    expect(out.value.tracks[0]!.parts.intro).toMatchObject({ chords: "Fm | Db", style: "offbeat", octave: 2 });
  });
});

describe("parseSong: misspelled keys are errors, never silent defaults", () => {
  it.each([
    ["a song-level typo (tempoo would silently keep the default tempo)", { ...minimal, tempoo: 140 }],
    ["a track-level typo (levl would silently keep 0 dB)", withTrack({ name: "Bass", role: "bass", levl: -6, parts: { intro: { chords: "Fm", style: "offbeat" } } })],
    ["a section-level typo", { ...minimal, sections: [{ name: "intro", bars: 4, bpm: 140 }] }],
  ])("rejects %s", (_label, song) => {
    const out = parseSong(song);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.message).toMatch(/unrecognized|Unrecognized/);
  });
});

describe("parseSong: audio clips (M7, section-relative)", () => {
  const sections = [{ name: "intro", bars: 4 }, { name: "chorus", bars: 8 }];
  const vox = (audio: object[]) => ({ ...minimal, sections,
    tracks: [{ name: "Vox", role: "lead", donorTrack: 2, parts: {}, audio }] });

  it("accepts a clip placed in a section and defaults bar and beat to 1", () => {
    const out = parseSong(vox([{ wav: "stems/vox.wav", section: "chorus" }]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.tracks[0]!.audio).toEqual([{ wav: "stems/vox.wav", section: "chorus", bar: 1, beat: 1 }]);
    expect(out.value.tracks[0]!.donorTrack).toBe(2);
  });

  const clip = { wav: "stems/vox.wav", section: "chorus" };
  const track = (over: object) => ({ ...minimal, sections, tracks: [{ name: "Vox", role: "lead", parts: {}, ...over }] });
  it.each([
    ["audio without donorTrack", track({ audio: [clip] }), "tracks.0.donorTrack"],
    ["donorTrack without audio", track({ donorTrack: 2 }), "tracks.0.audio"],
    ["a clip in an unknown section", track({ donorTrack: 2, audio: [{ ...clip, section: "bridge" }] }), "tracks.0.audio.0.section"],
    ["a bar past the section's end", track({ donorTrack: 2, audio: [{ ...clip, bar: 9 }] }), "tracks.0.audio.0.bar"],
    ["a beat past the bar (4/4)", track({ donorTrack: 2, audio: [{ ...clip, beat: 5 }] }), "tracks.0.audio.0.beat"],
  ])("rejects %s", (_label, song, path) => {
    const out = parseSong(song);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.path).toBe(path);
  });
});
