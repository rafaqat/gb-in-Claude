// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { DRUM_VOICES } from "./drums.js";
import { parseSong } from "../song/schema.js";
import { renderSong } from "../song/render.js";

// M14: Latin and world percussion as General MIDI percussion notes (channel 10), for salsa, cumbia, bachata, dembow …
const LATIN = {
  tambourine: 54, cowbell: 56, "bongo-high": 60, "bongo-low": 61, "conga-mute": 62, "conga-high": 63, "conga-low": 64,
  "timbale-high": 65, "timbale-low": 66, "agogo-high": 67, "agogo-low": 68, cabasa: 69, "guiro-short": 73,
  "guiro-long": 74, claves: 75, "woodblock-high": 76, "woodblock-low": 77, "triangle-mute": 80, triangle: 81,
};

describe("drum voices", () => {
  it("has the Latin and world percussion voices on their General MIDI notes", () => {
    expect(DRUM_VOICES).toMatchObject(LATIN);
  });

  it("gives every voice its own note, so a rendered note names one voice", () => {
    const notes = Object.values(DRUM_VOICES);
    expect(new Set(notes).size).toBe(notes.length);
  });

  it("renders a clave and conga grid in a Song JSON drum part", () => {
    const p = parseSong({ title: "t", tempo: 100, humanize: "off", sections: [{ name: "a", bars: 1 }],
      tracks: [{ name: "Perc", role: "drums", parts: { a: { grid: { claves: "x..x..x...x.x...", "conga-high": "..x...x...x...x." } } } }] });
    if (!p.ok) throw new Error(p.error.message);
    const r = renderSong(p.value);
    if (!r.ok) throw new Error(r.error.message);
    const pitches = r.value.tracks[0]!.notes.map((n) => n.pitch);
    expect(pitches.filter((x) => x === 75)).toHaveLength(5);
    expect(pitches.filter((x) => x === 63)).toHaveLength(4);
  });
});
