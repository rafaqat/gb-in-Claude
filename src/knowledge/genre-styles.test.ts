// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { GENRE_STYLES, GENRES_GUIDE } from "./genre-styles.js";
import { GENRE_TEMPLATES } from "../song/genres.js";

describe("genre styles (M14): caption words for gb_generate per genre", () => {
  it("covers every genre that has a template, and no other", () => {
    expect(Object.keys(GENRE_STYLES).sort()).toEqual(Object.keys(GENRE_TEMPLATES).sort());
  });

  it.each(Object.entries(GENRE_STYLES))("%s: sound, voice and production words that fit a caption; a tempo range around the template's", (genre, s) => {
    expect(s.sound.length).toBeGreaterThan(40);
    expect(s.voice.length).toBeGreaterThan(10);
    expect(s.production.length).toBeGreaterThan(10);
    // a caption is one paragraph ≤ 1000 characters: the three parts leave room for the mood and the arrangement
    expect(`${s.sound} ${s.voice} ${s.production}`.length).toBeLessThanOrEqual(600);
    const [lo, hi] = s.bpm;
    expect(lo).toBeLessThan(hi);
    expect(GENRE_TEMPLATES[genre]!.defaultBpm).toBeGreaterThanOrEqual(lo);
    expect(GENRE_TEMPLATES[genre]!.defaultBpm).toBeLessThanOrEqual(hi);
  });

  it("the guide lists every genre with its caption words", () => {
    for (const [genre, s] of Object.entries(GENRE_STYLES)) {
      expect(GENRES_GUIDE).toContain(`### ${genre}`);
      expect(GENRES_GUIDE).toContain(s.sound);
    }
  });
});
