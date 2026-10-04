// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BRIEFS_DIR, loadBriefs } from "./briefs.js";
import { validateSong } from "../song/validate.js";

/** The evaluation set's genres: 15 common genres at their target tempos, plus EDM, a crossover and three named styles. */
const REQUIRED_BPM: Record<string, number> = {
  "lo-fi hip-hop": 85, "R&B": 75, ambient: 70, "jazz ballad": 80, reggaeton: 95, synthwave: 100, pop: 105,
  afrobeats: 108, funk: 110, "indie rock": 120, "deep house": 122, techno: 130, "UK garage": 132, trap: 140,
  "drum and bass": 174,
};

describe("the frozen evaluation set (M8): briefs every later milestone is measured on", () => {
  const set = loadBriefs();
  const briefs = set.ok ? set.value : [];

  it("loads 20 briefs with unique ids that match their file names", () => {
    expect(set).toMatchObject({ ok: true });
    expect(briefs).toHaveLength(20);
    expect(new Set(briefs.map((b) => b.id)).size).toBe(20);
    for (const b of briefs) expect(b.file).toBe(`${b.id}.json`);
  });

  it("covers every genre of the spec at its target BPM, plus five more — 20 distinct genres", () => {
    expect(new Set(briefs.map((b) => b.genre)).size).toBe(20);
    for (const [genre, bpm] of Object.entries(REQUIRED_BPM)) {
      expect(briefs.find((b) => b.genre === genre)?.bpm, genre).toBe(bpm);
    }
  });

  it("spans tempos outside Foundation-1's 100–150 BPM tags on both sides", () => {
    const bpms = briefs.map((b) => b.bpm);
    expect(Math.min(...bpms)).toBeLessThan(100);
    expect(Math.max(...bpms)).toBeGreaterThan(150);
  });

  it.each(briefs.map((b) => [b.id, b] as const))("%s: metadata agrees with its song, and the song renders (no validation errors)", (_id, b) => {
    expect(b.song.tempo).toBe(b.bpm);
    expect(b.song.key).toBe(b.key);
    expect(`${b.song.timeSignature[0]}/${b.song.timeSignature[1]}`).toBe(b.meter);
    const errors = validateSong(b.song).filter((i) => i.severity === "error");
    expect(errors).toEqual([]);
  });

  it("is frozen: every brief file matches the hash recorded at the baseline (edit nothing — add a new set instead)", () => {
    const frozen = readFileSync(join(BRIEFS_DIR, "FROZEN.sha256"), "utf8").trim().split("\n").map((l) => l.split(/\s+/));
    expect(frozen.map(([, file]) => file)).toEqual(briefs.map((b) => b.file));
    for (const [hash, file] of frozen) {
      expect(createHash("sha256").update(readFileSync(join(BRIEFS_DIR, file!))).digest("hex"), file).toBe(hash);
    }
  });
});
