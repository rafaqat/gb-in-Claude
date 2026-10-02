// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { previewSong } from "./preview.js";
import { parseSong, type Song } from "./schema.js";

const song = (input: object): Song => {
  const r = parseSong(input);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

const demo = song({
  title: "Demo", tempo: 132, humanize: "off",
  sections: [{ name: "intro", bars: 2 }, { name: "drop", bars: 2 }],
  tracks: [
    { name: "Drums", role: "drums", parts: { drop: { grid: { kick: "x...x...x...x...", hat: "..x...x...x...x." } } } },
    { name: "Bass", role: "bass", parts: { drop: { chords: "Fm", style: "offbeat" } } },
    { name: "Lead", role: "lead", parts: { intro: { notes: "c5@2 ~ eb5" } } },
  ],
});

describe("previewSong", () => {
  it("draws one section as a 16th-note grid: drums per voice, melodic tracks per track; x = onset, - = held", () => {
    expect(previewSong(demo, { section: "drop" })).toBe([
      "drop (bars 3–4)  |1   2   3   4   |1   2   3   4   |",
      "Drums kick       |x...x...x...x...|x...x...x...x...|",
      "Drums hat        |..x...x...x...x.|..x...x...x...x.|",
      "Bass             |..x...x...x...x.|..x...x...x...x.|",
      "Lead             |................|................|",
    ].join("\n"));
  });

  it("shows held notes with - and limits to maxBars", () => {
    expect(previewSong(demo, { section: "intro", maxBars: 1 }).split("\n")[3]).toBe(
      "Lead             |x-------....x---|",
    );
  });

  it("labels a single-bar view as 'bar N'", () => {
    expect(previewSong(demo, { section: "drop", maxBars: 1 }).split("\n")[0]).toBe("drop (bar 3)     |1   2   3   4   |");
  });

  it("returns a clear message for an unknown section", () => {
    expect(previewSong(demo, { section: "chorus" })).toBe('unknown section "chorus"; sections: intro, drop');
  });
});
