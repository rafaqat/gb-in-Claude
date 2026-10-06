// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { GENRE_TEMPLATES, templateSong } from "./genres.js";
import { parseSong } from "./schema.js";
import { validateSong } from "./validate.js";
import { loadBriefs } from "../eval/briefs.js";
import { COMMON_LOOPS } from "./common-loops.js";
import { romanToChords } from "./roman.js";
import { renderSong } from "./render.js";
import { ORCHESTRAL_KIT_ONLY, type DrumVoice } from "../composition/drums.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const briefs = loadBriefs();

describe("genre templates (M9): a full Song JSON draft for every genre gb-mcp knows", () => {
  it("covers every genre of the evaluation set", () => {
    if (!briefs.ok) throw new Error(briefs.error);
    for (const b of briefs.value) expect(Object.keys(GENRE_TEMPLATES), b.genre).toContain(b.genre);
  });

  it.each((briefs.ok ? briefs.value : []).map((b) => [b.genre, b] as const))("%s at the brief's key, tempo and meter: valid, renders without errors", (_g, b) => {
    const r = templateSong({ genre: b.genre, key: b.key, bpm: b.bpm, meter: Number(b.meter[0]), title: `m9 ${b.id}` });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parsed = parseSong(r.value);
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) return;
    expect(parsed.value.tempo).toBe(b.bpm);
    expect(parsed.value.key).toBe(b.key);
    expect(validateSong(parsed.value).filter((i) => i.severity === "error")).toEqual([]);
  });

  // Live GarageBand renders: the "Classic Analog Pad" patch (program 89) and an outro with drums but no bass moved the
  // beat tracker half a beat off (afrobeats grid recall 0.56); string pad + outro bass: recall 0.97
  it("afrobeats: every section with drums has bass, and the pad is not program 89", () => {
    const r = templateSong({ genre: "afrobeats", key: "A minor", bpm: 108 });
    if (!r.ok) throw new Error(r.error);
    const song = r.value as { tracks: { role: string; program?: number; parts: Record<string, unknown> }[] };
    const drums = Object.keys(song.tracks.find((t) => t.role === "drums")!.parts);
    const bass = Object.keys(song.tracks.find((t) => t.role === "bass")!.parts);
    for (const section of drums) expect(bass, section).toContain(section);
    expect(song.tracks.find((t) => t.role === "pad")!.program).not.toBe(89);
  });

  // M13.17 screen (eval/m13-17): the 808 kit moved afrobeats up in CLAP's genre ranking on every seed and key screened.
  // Kit 25: GarageBand plays 24 and 25 as Boutique 808; the GM draft synth plays only 25 as a TR-808 (24: its Electronic kit)
  it("afrobeats: the drums are Boutique 808 on GM kit 25", () => {
    const r = templateSong({ genre: "afrobeats", key: "G major", bpm: 108 });
    if (!r.ok) throw new Error(r.error);
    const song = r.value as { tracks: { role: string; program?: number }[] };
    expect(song.tracks.find((t) => t.role === "drums")!.program).toBe(25);
  });

  // M14: the labels CLAP ranks against (models/gbmodels/genres.py) are the genres a template exists for
  const clapLabels = [...readFileSync(fileURLToPath(new URL("../../models/gbmodels/genres.py", import.meta.url)), "utf8")
    .split("CLAP_PROMPTS")[0]!  // the label lists only, not the prompt texts after them
    .matchAll(/^\s+"([^"]+)"[,\]]|"([^"]+)",/gm)].map((m) => m[1] ?? m[2]!);

  it("has a template for each of the 47 genres CLAP knows, and no other", () => {
    expect(new Set(clapLabels).size).toBe(47);
    expect(Object.keys(GENRE_TEMPLATES).sort()).toEqual([...new Set(clapLabels)].sort());
  });

  // every key: a hook written at a fixed octave left the instrument's range in high keys (lo-fi vibraphone G6 in C)
  const KEYS = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"].flatMap((t) => [`${t} major`, `${t} minor`])
    .map((k) => k.replace("Ab minor", "G# minor"));
  it.each(Object.keys(GENRE_TEMPLATES))("%s in all 24 keys at its own tempo: valid, renders, no validation errors", (genre) => {
    for (const key of KEYS) {
      const r = templateSong({ genre, key });
      expect(r.ok, key).toBe(true);
      if (!r.ok) return;
      const parsed = parseSong(r.value);
      expect(parsed, key).toMatchObject({ ok: true });
      if (!parsed.ok) return;
      expect(validateSong(parsed.value).filter((i) => i.severity === "error").map((i) => `${key}: ${i.message}`)).toEqual([]);
      expect(renderSong(parsed.value).ok, key).toBe(true);
    }
  });

  // M14 live probe (out/probe-export/m14-perc-probe-v1.wav): on GarageBand only the Orchestral Kit plays hand percussion
  // (congas, bongos, timbales, güiro …) as distinct sounds — SoCal, Retro Rock and Roots are silent on those notes, and
  // Boutique 808 and Electro play one pitched sound across them
  it.each(Object.keys(GENRE_TEMPLATES))("%s: hand percussion plays on the Orchestral Kit, in its own drum track", (genre) => {
    const r = templateSong({ genre, key: "C minor" });
    if (!r.ok) throw new Error(r.error);
    type Drum = { name: string; role: string; program?: number; parts: Record<string, { grid: Record<string, string> }> };
    for (const t of (r.value.tracks as Drum[]).filter((x) => x.role === "drums")) {
      const voices = Object.values(t.parts).flatMap((p) => Object.keys(p.grid));
      if (voices.some((v) => ORCHESTRAL_KIT_ONLY.has(v as DrumVoice))) expect(t.program, `${t.name}: ${voices.join(" ")}`).toBe(40);
    }
  });

  it("salsa: the conga, timbale and cowbell parts are in a Percussion track, the kit keeps what any kit plays", () => {
    const r = templateSong({ genre: "salsa", key: "C minor" });
    if (!r.ok) throw new Error(r.error);
    const names = (r.value.tracks as { name: string; role: string }[]).filter((t) => t.role === "drums").map((t) => t.name);
    expect(names).toEqual(["Drums", "Percussion"]);
  });

  // M14 live: without a kick on the beat, the beat tracker followed gnawa's and chaabi's triplet hats and congas
  // (1.5× tempo) and dabke's off-beats (recall 0.70 / 0.83 / 0.75); a kick on every beat: 0.99 / 1.00 / 0.99
  it.each([["gnawa", "x..x..x..x.."], ["Moroccan chaabi", "x..x..x..x.."], ["dabke", "x...x...x...x..."]])("%s: a kick on every beat", (genre, kick) => {
    expect(GENRE_TEMPLATES[genre]!.drums!.full.kick).toBe(kick);
  });

  it("refuses an unknown genre with the list of known ones", () => {
    const r = templateSong({ genre: "polka", key: "C major", bpm: 120 });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toContain("deep house");
  });
});

describe("template variants (M13.16): the genre's common loops (Chordonomicon statistics)", () => {
  type Draft = { tracks: { name: string; parts: Record<string, { chords?: string }> }[] };
  /** the chords a section plays: from the first track that plays chords there */
  const chordsAt = (song: unknown, section: string) =>
    (song as Draft).tracks.map((t) => t.parts[section]?.chords).find((c) => c !== undefined);
  const sectionOf = (genre: string, prog: "a" | "b") =>
    GENRE_TEMPLATES[genre]!.form.find((s) => (s.prog ?? "a") === prog && (s.pad || s.bass))!.name;

  it("variant 1 plays the most common verse loop in a-sections and the chorus loop in b-sections", () => {
    const r = templateSong({ genre: "indie rock", key: "C major", variant: 1 });
    expect(r.ok).toBe(true);
    const song = (r as { value: unknown }).value;
    const loops = COMMON_LOOPS["indie rock"]!.major;
    expect(chordsAt(song, sectionOf("indie rock", "a"))).toBe(romanToChords(loops.verse[0]!, "C major"));
    expect(chordsAt(song, sectionOf("indie rock", "b"))).toBe(romanToChords(loops.chorus[0]!, "C major"));
  });

  it("keeps the template's colour: a genre written in sevenths gets its loops in sevenths", () => {
    const r = templateSong({ genre: "lo-fi hip-hop", key: "C major", variant: 2 });
    const verse = COMMON_LOOPS["lo-fi hip-hop"]!.major.verse[1]!; // triads, e.g. "I | vi | V | IV"
    const sevenths = verse.split("|").map((c) => ({ I: "Imaj7", ii: "ii7", iii: "iii7", IV: "IVmaj7", V: "V7", vi: "vi7" })[c.trim() as "I"]).join(" | ");
    expect(chordsAt((r as { value: unknown }).value, sectionOf("lo-fi hip-hop", "a"))).toBe(romanToChords(sevenths, "C major"));
  });

  it("variant 0 is the hand-written template", () => {
    expect(templateSong({ genre: "trap", key: "F minor", variant: 0 })).toEqual(templateSong({ genre: "trap", key: "F minor" }));
  });

  it("every genre has 3 verse and 3 chorus loops per mode, and each one renders in a major and a minor key", () => {
    for (const genre of Object.keys(GENRE_TEMPLATES)) {
      const loops = COMMON_LOOPS[genre];
      expect(loops, genre).toBeDefined();
      for (const [mode, key] of [["major", "Eb major"], ["minor", "C# minor"]] as const) {
        expect([loops![mode].verse.length, loops![mode].chorus.length], `${genre} ${mode}`).toEqual([3, 3]);
        for (const variant of [1, 2, 3]) {
          const r = templateSong({ genre, key, variant });
          expect(r.ok, `${genre} ${key} variant ${variant}`).toBe(true);
        }
      }
    }
  });
});
