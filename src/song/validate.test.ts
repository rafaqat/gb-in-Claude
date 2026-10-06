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

describe("validateSong: expression against what the patch can do (M11, probe 2026-10-04)", () => {
  const check = (track: object, sections: object[] = [{ name: "a", bars: 1 }]) => {
    const p = parseSong({ title: "t", tempo: 100, sections, tracks: [{ name: "X", role: "lead", ...track }] });
    if (!p.ok) throw new Error(p.error.message);
    return validateSong(p.value);
  };
  const codes = (issues: ReturnType<typeof check>) => issues.map((i) => `${i.severity}:${i.code}`);
  it("Flute Solo slides up to ±12 semitones; wider is an error", () => {
    expect(codes(check({ program: 73, parts: { a: { notes: "c5@3>c6@1" } } }))).toEqual([]);
    expect(codes(check({ program: 73, parts: { a: { notes: "c5@3>d6@1" } } }))).toContain("error:BEND_RANGE");
  });
  it("±2-semitone patches (Soft Saw Lead, String Ensemble) refuse a third, accept a whole step", () => {
    expect(codes(check({ program: 81, parts: { a: { notes: "c5@3>d5@1" } } }))).toEqual([]);
    const issues = check({ program: 48, parts: { a: { notes: "c5@3>e5@1" } } });
    expect(codes(issues)).toContain("error:BEND_RANGE");
    expect(issues.find((i) => i.code === "BEND_RANGE")!.message).toContain("±2");
  });
  it("the harp does not bend: a slide or a cent offset is an error; explicit vibrato is a warning", () => {
    expect(codes(check({ program: 46, parts: { a: { notes: "c5@3>d5@1" } } }))).toContain("error:BEND_RANGE");
    expect(codes(check({ program: 46, parts: { a: { notes: "c5-20c" } } }))).toContain("error:BEND_RANGE");
    expect(codes(check({ program: 46, vibrato: "wide", parts: { a: { notes: "c5" } } }))).toContain("warning:NO_PITCH_BEND");
  });
  it("a bend on a track that also plays chords is an error (a bend moves every note on the channel)", () => {
    expect(codes(check({ program: 73, parts: { a: { notes: "c5@3>d5@1 [c5,e5]" } } }))).toContain("error:BEND_NEEDS_MONO");
    const pad = check({ role: "pad", program: 81, parts: { a: { notes: "c5@3>d5@1" }, b: { chords: "C", style: "sustain" } } },
      [{ name: "a", bars: 1 }, { name: "b", bars: 1 }]);
    expect(codes(pad)).toContain("error:BEND_NEEDS_MONO");
  });
  it("Steinway Grand Piano and Fingerstyle Bass were measured at ±2 (M11 gate, .band export): a whole step, no warning", () => {
    expect(codes(check({ program: 0, vibrato: "off", parts: { a: { notes: "c5@3>d5@1" } } }))).toEqual([]);
    expect(codes(check({ role: "bass", program: 33, parts: { a: { notes: "a2@3>b2@1" } } }))).toEqual([]);
  });
  it("an unmeasured patch's bend range is assumed ±2 (warning); brightness on a sampled patch is a warning", () => {
    expect(codes(check({ program: 71, parts: { a: { notes: "c5@3>d5@1" } } }))).toContain("warning:BEND_RANGE_UNMEASURED");
    expect(codes(check({ program: 73, parts: { a: { notes: "c5", brightness: 0.2 } } }))).toContain("warning:BRIGHTNESS_SYNTH_ONLY");
    expect(codes(check({ program: 81, parts: { a: { notes: "c5", brightness: 0.2 } } }))).toEqual([]);
  });
});

describe("validateSong: voice leading (M13.4, warnings only)", () => {
  const two = { title: "T", tempo: 120, sections: [{ name: "a", bars: 2 }] };
  const leadOverBass = (lead: string, bassChords: string) => song({ ...two, tracks: [
    { name: "Lead", role: "lead", parts: { a: { notes: lead } } },
    { name: "Bass", role: "bass", parts: { a: { chords: bassChords, style: "sustain" } } },
  ] });
  const issues = (lead: string, bassChords: string) => validateSong(leadOverBass(lead, bassChords), { voiceLeading: true });

  it("is opt-in: by default validate says nothing about voice leading (pop and EDM double the bass on purpose)", () => {
    expect(validateSong(leadOverBass("g4 | a4", "C | D")).map((i) => i.code)).not.toContain("PARALLEL_FIFTHS");
  });

  it("warns when the lead and the bass move in parallel fifths, naming the bar", () => {
    const w = issues("g4 | a4", "C | D").find((i) => i.code === "PARALLEL_FIFTHS");
    expect(w).toMatchObject({ severity: "warning", path: "tracks.Lead" });
    expect(w!.message).toMatch(/Bass.*bar 2/);
  });

  it("warns about parallel octaves", () => {
    expect(issues("c5 | d5", "C | D").map((i) => i.code)).toContain("PARALLEL_OCTAVES");
  });

  it("says nothing for contrary motion, even into a perfect fifth (g5 → a4 over C → D)", () => {
    expect(issues("g5 | a4", "C | D").filter((i) => i.code.startsWith("PARALLEL"))).toEqual([]);
  });

  it("warns about a leap over an octave inside a phrase", () => {
    expect(issues("c5 e6 | d5", "C | D").map((i) => i.code)).toContain("LARGE_LEAP");
  });

  it("warns when the lead goes below the bass", () => {
    expect(issues("c5 | c2", "C | D").map((i) => i.code)).toContain("VOICE_CROSSING");
  });
});
