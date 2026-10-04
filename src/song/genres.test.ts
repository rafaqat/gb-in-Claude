// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { GENRE_TEMPLATES, templateSong } from "./genres.js";
import { parseSong } from "./schema.js";
import { validateSong } from "./validate.js";
import { loadBriefs } from "../eval/briefs.js";

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

  it("refuses an unknown genre with the list of known ones", () => {
    const r = templateSong({ genre: "polka", key: "C major", bpm: 120 });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toContain("deep house");
  });
});
