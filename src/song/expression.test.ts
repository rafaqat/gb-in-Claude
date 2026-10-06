// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { applyExpression, sectionTimes } from "./expression.js";
import { renderSong, PPQ } from "./render.js";
import { parseSong } from "./schema.js";

/** Render a song (no humanize: deterministic) and apply expression. */
function express(input: object) {
  const p = parseSong({ title: "t", tempo: 120, humanize: "off", ...input });
  if (!p.ok) throw new Error(`${p.error.path}: ${p.error.message}`);
  const r = renderSong(p.value);
  if (!r.ok) throw new Error(r.error.message);
  return applyExpression(p.value, r.value.tracks, PPQ);
}
const lead = (notes: string, extra: object = {}, program = 73) => ({
  sections: [{ name: "a", bars: 1 }],
  tracks: [{ name: "L", role: "lead", program, parts: { a: { notes } }, ...extra }],
});
const BAR = 4 * PPQ;

describe("applyExpression: pitch bends (meend, shruti, vibrato)", () => {
  it("a slide on Flute Solo sends RPN 12 and bends smoothly up to +2 semitones, arriving on time; the next note starts unbent", () => {
    const { tracks } = express(lead("d5@3>e5@1 a4@4", { vibrato: "off" })); // the slide token is half the bar
    const t = tracks[0]!;
    expect(t.bendRange).toBe(12);
    const arrive = (BAR / 2) * 0.75; // the slide token is half the bar; e5 arrives at 3/4 of it
    const bends = t.bends!.filter((b) => b.tick <= arrive);
    expect(bends[0]).toEqual({ tick: 0, value: 0 });
    expect(bends[bends.length - 1]).toEqual({ tick: arrive, value: Math.round((2 / 12) * 8192) });
    for (let i = 1; i < bends.length; i++) expect(bends[i]!.value).toBeGreaterThanOrEqual(bends[i - 1]!.value);
    expect(t.bends!.find((b) => b.tick === BAR / 2)).toEqual({ tick: BAR / 2, value: 0 }); // reset before a4's note-on
  });
  it("on a ±2 patch (Soft Saw Lead) the same slide uses the full scale and sends no RPN", () => {
    const t = express(lead("d5@3>e5@1 a4@4", { vibrato: "off" }, 81)).tracks[0]!;
    expect(t.bendRange).toBeUndefined();
    expect(Math.max(...t.bends!.map((b) => b.value))).toBe(8191);
  });
  it("a cent offset holds the note off-grid for its length (shruti): e5-20c", () => {
    const t = express(lead("e5-20c a4", { vibrato: "off" })).tracks[0]!;
    expect(t.bends).toEqual([{ tick: 0, value: Math.round((-0.2 / 12) * 8192) }, { tick: BAR / 2, value: 0 }]);
  });
  it("leads get pitch-bend vibrato on long notes by default: none in the first third, within ±25 cents after", () => {
    const t = express(lead("a4@2 ~@2")).tracks[0]!; // 2 beats
    const units = Math.round((0.25 / 12) * 8192);
    expect(t.bends!.length).toBeGreaterThan(10);
    expect(t.bends!.filter((b) => b.tick > 0 && b.tick < PPQ * 2 / 3 && b.value !== 0)).toEqual([]);
    expect(Math.max(...t.bends!.map((b) => Math.abs(b.value)))).toBeLessThanOrEqual(units);
    expect(Math.max(...t.bends!.map((b) => Math.abs(b.value)))).toBeGreaterThan(units / 2);
    expect(t.controllers ?? []).toEqual([]); // no CC1: sampled patches ignore it (probe 2026-10-04)
  });
  it("no bends where they would do nothing or are not asked for: a harp lead, vibrato off, a pad", () => {
    expect(express(lead("a4@4", {}, 46)).tracks[0]!.bends ?? []).toEqual([]);
    expect(express(lead("a4@4", { vibrato: "off" })).tracks[0]!.bends ?? []).toEqual([]);
    const pad = express({ sections: [{ name: "a", bars: 1 }], tracks: [{ name: "P", role: "pad", program: 48, parts: { a: { notes: "a4@4" } } }] });
    expect(pad.tracks[0]!.bends ?? []).toEqual([]);
  });
});

describe("applyExpression: part controllers (dynamics CC11, pedal CC64, pan CC10, brightness CC74, volume CC7)", () => {
  const two = (a: object, b: object = {}, role = "pad", program = 48) => express({
    sections: [{ name: "a", bars: 2 }, { name: "b", bars: 1 }],
    tracks: [{ name: "T", role, program, vibrato: "off", parts: { a: { notes: "a3@4", ...a }, b: { notes: "a3@4", ...b } } }],
  }).tracks[0]!;
  const cc = (t: ReturnType<typeof two>, n: number) => (t.controllers ?? []).filter((c) => c.controller === n);
  it("a hairpin p<f rises smoothly from p (50) to f (100) across the section; an unmarked section returns to full (127)", () => {
    const c = cc(two({ dynamics: "p<f" }), 11);
    expect(c[0]).toEqual({ tick: 0, controller: 11, value: 50 });
    const inA = c.filter((x) => x.tick < 2 * BAR);
    for (let i = 1; i < inA.length; i++) expect(inA[i]!.value).toBeGreaterThanOrEqual(inA[i - 1]!.value);
    expect(inA[inA.length - 1]!.value).toBeGreaterThanOrEqual(97);
    expect(c.find((x) => x.tick === 2 * BAR)).toEqual({ tick: 2 * BAR, controller: 11, value: 127 });
  });
  it("pp<ff>mp: up for the first half, down for the second", () => {
    const c = cc(two({ dynamics: "pp<ff>mp" }), 11).filter((x) => x.tick < 2 * BAR);
    const peak = c.reduce((m, x) => (x.value > m.value ? x : m));
    expect(peak.value).toBe(115);
    expect(Math.abs(peak.tick - BAR)).toBeLessThanOrEqual(PPQ / 4);
    expect(c[c.length - 1]!.value).toBeLessThan(75);
  });
  it("pedal 'bar': down just after each bar line, up just before the next; up at the section end", () => {
    const c = cc(two({ pedal: "bar" }), 64);
    expect(c.map((x) => x.value)).toEqual([127, 0, 127, 0]);
    expect(c[0]!.tick).toBeGreaterThan(0);
    expect(c[1]!.tick).toBeLessThan(BAR);
    expect(c[3]!.tick).toBeLessThan(2 * BAR);
  });
  it("pan: fixed left; an auto-pan cycles around the centre by its depth; unmarked sections return to the centre", () => {
    expect(cc(two({ pan: -1 }), 10)).toEqual([{ tick: 0, controller: 10, value: 1 }, { tick: 2 * BAR, controller: 10, value: 64 }]);
    const auto = cc(two({ pan: { cycle: 1, depth: 0.5 } }), 10).filter((x) => x.tick < 2 * BAR).map((x) => x.value);
    expect(Math.max(...auto)).toBeGreaterThanOrEqual(94);
    expect(Math.min(...auto)).toBeLessThanOrEqual(34);
  });
  it("brightness and volume ramps: CC74 0→127, CC7 fade-in 0→100", () => {
    const t = two({ brightness: { from: 0, to: 1 }, volume: { from: 0, to: 1 } });
    expect(cc(t, 74)[0]!.value).toBe(0);
    expect(Math.max(...cc(t, 74).map((x) => x.value))).toBeGreaterThanOrEqual(124);
    expect(cc(t, 7)[0]!.value).toBe(0);
    const atB = cc(t, 7).filter((x) => x.tick <= 2 * BAR); // the volume in effect when section b starts
    expect(atB[atB.length - 1]!.value).toBe(100);
  });
  it("a drum part can fade (CC7 on channel 10)", () => {
    const d = express({ sections: [{ name: "a", bars: 1 }], tracks: [{ name: "D", role: "drums", parts: { a: { grid: { kick: "x..." }, volume: { from: 1, to: 0 } } } }] });
    const c = (d.tracks[0]!.controllers ?? []).filter((x) => x.controller === 7);
    expect(c[0]!.value).toBe(100);
    expect(c[c.length - 1]!.value).toBeLessThanOrEqual(5);
  });
  it("tracks without expression get no controllers", () => {
    expect(two({}).controllers ?? []).toEqual([]);
  });
});

describe("applyExpression: conductor (tempo map, markers, key signature)", () => {
  const song = (sections: ({ name: string } & Record<string, unknown>)[], key?: string) => express({ ...(key ? { key } : {}), sections,
    tracks: [{ name: "P", role: "pad", program: 48, parts: { [sections[0]!.name]: { notes: "a3" } } }] });
  it("a section tempo starts there; tempoTo ramps beat by beat to arrive at its last beat; the tempo holds afterwards", () => {
    const r = song([{ name: "a", bars: 1 }, { name: "b", bars: 1, tempo: 100, tempoTo: 80 }, { name: "c", bars: 1 }]);
    const map = r.tempoMap!;
    expect(map[0]).toEqual({ tick: BAR, bpm: 100 });
    expect(map[map.length - 1]).toEqual({ tick: BAR + 3 * PPQ, bpm: 80 });
    expect(map.every((t) => t.tick < 2 * BAR)).toBe(true); // c keeps 80
  });
  it("no tempo fields, no tempo map", () => {
    expect(song([{ name: "a", bars: 1 }]).tempoMap).toBeUndefined();
  });
  it("a marker per section start; non-ASCII names become safe text", () => {
    expect(song([{ name: "aalap", bars: 1 }, { name: "mukhḍa", bars: 1 }]).markers).toEqual([{ tick: 0, text: "aalap" }, { tick: BAR, text: "mukh?a" }]);
  });
  it.each([["E minor", 1, true], ["F major", -1, false], ["Bb minor", -5, true], ["C# minor", 4, true], ["F# major", 6, false], ["Gb major", -6, false]])(
    "key %s → %i accidentals", (key, accidentals, minor) => {
      expect(song([{ name: "a", bars: 1 }], key).keySignature).toEqual({ accidentals, minor });
    });
});

describe("sectionTimes: real section times through the tempo map (for gb_analyze)", () => {
  it("a ritardando 120→60 over one bar stretches it (0.5 + 0.6 + 0.75 + 1.0 s) and the next bar runs at 60", () => {
    const p = parseSong({ title: "t", tempo: 120, sections: [{ name: "a", bars: 1 }, { name: "b", bars: 1, tempoTo: 60 }, { name: "c", bars: 1 }],
      tracks: [{ name: "P", role: "pad", parts: { a: { notes: "a3" } } }] });
    if (!p.ok) throw new Error(p.error.message);
    const t = sectionTimes(p.value).map((s) => [s.name, +s.start_s.toFixed(3), +s.end_s.toFixed(3)]);
    expect(t).toEqual([["a", 0, 2], ["b", 2, 4.85], ["c", 4.85, 8.85]]);
  });
});

describe("Song JSON tempoMap (M13.7): a tempo per bar, for a project that follows a drifting recording", () => {
  const base = { title: "T", tempo: 80, humanize: "off", sections: [{ name: "a", bars: 4 }],
    tracks: [{ name: "Pad", role: "pad", parts: { a: { chords: "C", style: "sustain" } } }] };

  it("renders a tempo event at each listed bar (and beat)", () => {
    const p = parseSong({ ...base, tempoMap: [{ bar: 2, bpm: 82 }, { bar: 3, beat: 3, bpm: 84.5 }] });
    if (!p.ok) throw new Error(JSON.stringify(p.error));
    const r = renderSong(p.value);
    if (!r.ok) throw new Error(r.error.message);
    expect(applyExpression(p.value, r.value.tracks, PPQ).tempoMap).toEqual([{ tick: 4 * PPQ, bpm: 82 }, { tick: (8 + 2) * PPQ, bpm: 84.5 }]);
    expect(sectionTimes(p.value)[0]!.end_s).toBeCloseTo(4 * 60 / 80 + 4 * 60 / 82 + 2 * 60 / 82 + 6 * 60 / 84.5, 6);
  });

  it("refuses bars that do not rise, a bar past the end, and a tempoMap next to section tempi", () => {
    expect(parseSong({ ...base, tempoMap: [{ bar: 3, bpm: 82 }, { bar: 2, bpm: 84 }] }).ok).toBe(false);
    expect(parseSong({ ...base, tempoMap: [{ bar: 5, bpm: 82 }] }).ok).toBe(false);
    expect(parseSong({ ...base, sections: [{ name: "a", bars: 4, tempo: 90 }], tempoMap: [{ bar: 2, bpm: 82 }] }).ok).toBe(false);
  });
});
