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

  it("refuses an unknown genre with the list of known ones", () => {
    const r = templateSong({ genre: "polka", key: "C major", bpm: 120 });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toContain("deep house");
  });
});
