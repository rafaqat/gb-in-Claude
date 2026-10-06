// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BRIEFS_M14_DIR, loadBriefs } from "./briefs.js";
import { validateSong } from "../song/validate.js";
import { GENRE_TEMPLATES } from "../song/genres.js";

const M14 = ["Latin trap", "dembow", "bachata", "salsa", "cumbia", "bossa nova", "corridos tumbados", "Latin pop",
  "Brazilian funk", "merengue", "Arabic pop", "Khaleeji", "mahraganat", "raï", "gnawa", "Moroccan chaabi", "dabke",
  "country", "Americana", "Bollywood (filmi)", "gospel", "soul", "blues", "Celtic folk", "lullaby", "K-pop", "amapiano"];

describe("the M14 evaluation set: one brief per new genre, frozen like the M8 set", () => {
  const set = loadBriefs(BRIEFS_M14_DIR);
  const briefs = set.ok ? set.value : [];

  it("loads 27 briefs (ids 21–47) for the 27 new genres, in their order", () => {
    expect(set).toMatchObject({ ok: true });
    expect(briefs.map((b) => b.genre)).toEqual(M14);
    expect(briefs.map((b) => Number(b.id.slice(0, 2)))).toEqual(M14.map((_, i) => 21 + i));
    for (const b of briefs) expect(b.file).toBe(`${b.id}.json`);
  });

  it.each(briefs.map((b) => [b.id, b] as const))("%s: metadata agrees with its song, the tempo is the template's, no validation errors", (_id, b) => {
    expect(b.song.tempo).toBe(b.bpm);
    expect(b.bpm).toBe(GENRE_TEMPLATES[b.genre]!.defaultBpm);
    expect(b.song.key).toBe(b.key);
    expect(validateSong(b.song).filter((i) => i.severity === "error")).toEqual([]);
  });

  it("is frozen: every brief file matches its recorded hash", () => {
    const frozen = readFileSync(join(BRIEFS_M14_DIR, "FROZEN.sha256"), "utf8").trim().split("\n").map((l) => l.split(/\s+/));
    expect(frozen.map(([, file]) => file)).toEqual(briefs.map((b) => b.file));
    for (const [hash, file] of frozen) {
      expect(createHash("sha256").update(readFileSync(join(BRIEFS_M14_DIR, file!))).digest("hex"), file).toBe(hash);
    }
  });
});
