// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { draftSong, type SongMap, type Transcription } from "./draft.js";
import { parseSong } from "./schema.js";
import { validateSong } from "./validate.js";

/** A 4-bar map at 120 BPM: GarageBand bar g starts at 2(g-1) s. */
const map = (over: Partial<SongMap> = {}): SongMap => ({
  key: "D Major", place: { guide_bpm: 120, bar: 1, beat: 1, offset_s: 0 }, tempo_map: null,
  bar_lines_s: [0, 2, 4, 6, 8], sections: null,
  gb: [{ bar: 1, chords: ["D", "D"] }, { bar: 2, chords: ["G", "A"] }, { bar: 3, chords: ["Bm", "Bm"] }, { bar: 4, chords: ["A", null] }],
  ...over,
});
const none: Transcription = { bass: [], bass_source: "bass", lead: [], lead_source: null, drums: { kick: [], snare: [], hat: [] } };

describe("draftSong (M13.14): the song map + transcribed stems → a Song JSON draft", () => {
  it("writes the bass on the map's GarageBand bars: 16 shares per bar, a note crossing a bar line struck again", () => {
    const song = draftSong(map(), { ...none, bass: [{ bar: 1, step: 0, len: 4, pitch: 38 }, { bar: 1, step: 8, len: 12, pitch: 43 }] }, { title: "take" });
    const bass = song.tracks.find((t) => t.role === "bass")!;
    expect(song.sections).toEqual([{ name: "song", bars: 4 }]);
    expect(bass.parts.song).toEqual({ notes: "d2@4 ~@4 g2@8 | g2@4 ~@12 | ~@16 | ~@16" });
  });

  it("a note that runs past the bar line by less than a beat (a release tail) ends at the bar line, not struck again", () => {
    const song = draftSong(map(), { ...none, bass: [{ bar: 1, step: 12, len: 6, pitch: 38 }, { bar: 2, step: 4, len: 4, pitch: 40 }] }, { title: "take" });
    expect(song.tracks.find((t) => t.role === "bass")!.parts.song).toEqual({ notes: "~@12 d2@4 | ~@4 e2@4 ~@8 | ~@16 | ~@16" });
  });

  it("a silent bass stem (Demucs left it empty) gives a bass on the map's chord roots, not silence", () => {
    const song = draftSong(map(), { ...none, bass_source: null }, { title: "take" });
    expect(song.tracks.find((t) => t.role === "bass")).toMatchObject({ name: "Bass", program: 33, parts: { song: { chords: "D | G A | Bm | A", style: "sustain" } } });
  });

  it("takes the map's sections (bars before the first one are a lead-in) and gives each its own part", () => {
    const sections = [{ name: "verse", gb_bar: 2, bars: 2 }, { name: "chorus", gb_bar: 4, bars: 1 }];
    const song = draftSong(map({ sections }), { ...none, bass: [{ bar: 2, step: 0, len: 16, pitch: 43 }, { bar: 4, step: 4, len: 4, pitch: 45 }] }, { title: "take" });
    expect(song.sections).toEqual([{ name: "lead-in", bars: 1 }, { name: "verse", bars: 2 }, { name: "chorus", bars: 1 }]);
    expect(song.tracks.find((t) => t.role === "bass")!.parts).toEqual({ verse: { notes: "g2@16 | ~@16" }, chorus: { notes: "~@4 a2@4 ~@8" } });
  });

  it("writes the drums as a 16-step grid per voice: X for the loudest hits, o for ghosts; a silent voice is left out", () => {
    const hit = (bar: number, step: number, strength: number) => ({ bar, step, strength });
    const song = draftSong(map(), { ...none, drums: { kick: [hit(1, 0, 1), hit(1, 8, 0.6), hit(3, 0, 0.9)], snare: [hit(1, 4, 0.7), hit(1, 12, 0.2)], hat: [] } }, { title: "take" });
    const drums = song.tracks.find((t) => t.role === "drums")!;
    expect(drums.parts.song).toEqual({ grid: {
      kick: "X.......x....... | ................ | X............... | ................",
      snare: "....x.......o... | ................ | ................ | ................",
    } });
  });

  it("writes the map's chords per half bar on a sustained keys track; an unknown half takes its neighbour's chord", () => {
    const song = draftSong(map(), none, { title: "take" });
    expect(song.tracks.find((t) => t.name === "Chords")).toMatchObject({ role: "pad", parts: { song: { chords: "D | G A | Bm | A", style: "sustain" } } });
    const silent = draftSong(map({ gb: [1, 2, 3, 4].map((bar) => ({ bar, chords: [null, null] })) }), none, { title: "take" });
    expect(silent.tracks.find((t) => t.name === "Chords")).toBeUndefined();
  });

  it("writes the lead: a sung one on Dream Voice (program 85), one from the instrument stem on Soft Saw Lead (81)", () => {
    const lead = [{ bar: 2, step: 0, len: 2, pitch: 74 }, { bar: 2, step: 2, len: 6, pitch: 76 }];
    const sung = draftSong(map(), { ...none, lead, lead_source: "vocals" }, { title: "take" });
    expect(sung.tracks.find((t) => t.role === "lead")).toEqual({ name: "Lead", role: "lead", program: 85, parts: { song: { notes: "~@16 | d5@2 e5@6 ~@8 | ~@16 | ~@16" } } });
    const played = draftSong(map(), { ...none, lead, lead_source: "other" }, { title: "take" });
    expect(played.tracks.find((t) => t.role === "lead")!.program).toBe(81);
  });

  it("plays at the map's tempo, follows a drifting take with its tempo map, and declares the key", () => {
    expect(draftSong(map(), none, { title: "take" })).toMatchObject({ tempo: 120, key: "D major" });
    const drift = draftSong(map({ key: "F# Minor", tempo_map: [{ bar: 1, bpm: 118.5 }, { bar: 3, bpm: 121.25 }] }), none, { title: "take" });
    expect(drift).toMatchObject({ tempo: 118.5, key: "F# minor", tempoMap: [{ bar: 3, bpm: 121.25 }] });
    expect(draftSong(map({ key: null }), none, { title: "take" }).key).toBeUndefined();
  });

  it("is a valid Song JSON with no musical errors: bass notes the bass cannot play move by octaves into its range", () => {
    const t: Transcription = {
      bass: [{ bar: 1, step: 0, len: 8, pitch: 24 }, { bar: 1, step: 8, len: 8, pitch: 70 }], bass_source: "bass",
      lead: [{ bar: 1, step: 0, len: 4, pitch: 79 }], lead_source: "vocals",
      drums: { kick: [{ bar: 1, step: 0, strength: 1 }], snare: [], hat: [{ bar: 2, step: 2, strength: 0.5 }] },
    };
    const draft = draftSong(map({ sections: [{ name: "verse", gb_bar: 1, bars: 4 }] }), t, { title: "take" });
    expect(draft.tracks.find((t) => t.role === "bass")!.parts.verse).toEqual({ notes: "c2@8 a#3@8 | ~@16 | ~@16 | ~@16" });
    const parsed = parseSong(draft);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(validateSong(parsed.value).filter((i) => i.severity === "error")).toEqual([]);
  });
});
