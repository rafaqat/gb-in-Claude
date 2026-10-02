// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { validateSong } from "./validate.js";
import { parseSong, type Song } from "./schema.js";

const song = (input: object): Song => {
  const r = parseSong(input);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};
const base = { title: "T", tempo: 120, sections: [{ name: "a", bars: 1 }] };

describe("validateSong: production warnings", () => {
  const codes = (input: object) => validateSong(song(input)).map((i) => [i.severity, i.code, i.path]);

  it("warns when the bass sits outside the bass register (E1–G3)", () => {
    expect(codes({ ...base, tracks: [{ name: "Bass", role: "bass", parts: { a: { chords: "Fm", style: "sustain", octave: 4 } } }] }))
      .toContainEqual(["warning", "ROLE_REGISTER", "tracks.Bass"]);
  });

  it("warns about sections where nothing plays", () => {
    expect(codes({ ...base, sections: [{ name: "a", bars: 1 }, { name: "gap", bars: 2 }],
      tracks: [{ name: "Lead", role: "lead", parts: { a: { notes: "c5" } } }] }))
      .toContainEqual(["warning", "EMPTY_SECTION", "sections.gap"]);
  });

  it("warns that humanize 'off' will sound mechanical", () => {
    expect(codes({ ...base, humanize: "off", tracks: [{ name: "Lead", role: "lead", parts: { a: { notes: "c5" } } }] }))
      .toContainEqual(["warning", "HUMANIZE_OFF", "humanize"]);
  });

  it("raises no warnings for a well-formed song", () => {
    expect(validateSong(song({ ...base, tracks: [
      { name: "Bass", role: "bass", parts: { a: { chords: "Fm", style: "offbeat" } } },
      { name: "Lead", role: "lead", parts: { a: { notes: "c5 eb5" } } },
    ] }))).toEqual([]);
  });
});

describe("validateSong: instrument ranges (the flute problem)", () => {
  it("flags notes outside a real instrument's playable range, naming the notes and the range", () => {
    const issues = validateSong(song({ ...base, style: "acoustic", tracks: [
      { name: "Lead", role: "lead", parts: { a: { notes: "f6 f7" } } }, // acoustic lead = Flute Solo (73), top ≈ C7
    ] }));
    expect(issues).toContainEqual({
      severity: "error",
      code: "OUT_OF_INSTRUMENT_RANGE",
      path: "tracks.Lead",
      message: 'Flute Solo (program 73) plays C4–C7; 1 note out of range: F7. Transpose the part, or move it to an instrument that reaches it (e.g. role "lead-high").',
    });
  });

  it("does not flag synth programs, whose range is the whole keyboard", () => {
    const issues = validateSong(song({ ...base, style: "club-trance", tracks: [
      { name: "Lead", role: "lead", parts: { a: { notes: "f6 f7" } } }, // Rising High Synth Lead (127)
    ] }));
    expect(issues.filter((i) => i.code === "OUT_OF_INSTRUMENT_RANGE")).toEqual([]);
  });

  it("accepts in-range real-instrument parts", () => {
    const issues = validateSong(song({ ...base, style: "acoustic", tracks: [
      { name: "Lead", role: "lead", parts: { a: { notes: "f5 c6" } } },
    ] }));
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
  });
});
