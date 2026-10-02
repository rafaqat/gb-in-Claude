// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { renderArpSpan, GATE_MASK } from "./arp-patterns.js";

const voicing = [53, 56, 60]; // Fm: F3 Ab3 C4

describe("renderArpSpan", () => {
  it("up: 16ths climbing the chord over two octaves, then repeating", () => {
    const notes = renderArpSpan("up", voicing, 4);
    expect(notes).toHaveLength(16);
    expect(notes.slice(0, 8).map((n) => n.pitch)).toEqual([53, 56, 60, 65, 68, 72, 53, 56]);
    expect(notes.slice(0, 3).map((n) => n.startBeat)).toEqual([0, 0.25, 0.5]);
  });

  it("down: the same pool, descending", () => {
    expect(renderArpSpan("down", voicing, 4).slice(0, 7).map((n) => n.pitch)).toEqual([72, 68, 65, 60, 56, 53, 72]);
  });

  it("updown: climbs then descends without repeating the turnaround notes", () => {
    expect(renderArpSpan("updown", voicing, 4).slice(0, 11).map((n) => n.pitch))
      .toEqual([53, 56, 60, 65, 68, 72, 68, 65, 60, 56, 53]);
  });

  it("broken: skips through the pool in thirds (1-3-2-4-3-5-4-6)", () => {
    expect(renderArpSpan("broken", voicing, 4).slice(0, 8).map((n) => n.pitch)).toEqual([53, 60, 56, 65, 60, 68, 65, 72]);
  });

  it("accents the first 16th of each beat", () => {
    const notes = renderArpSpan("up", voicing, 4);
    expect(notes[0]!.velocity).toBeGreaterThan(notes[1]!.velocity);
    expect(notes[4]!.velocity).toBe(notes[0]!.velocity);
  });

  it("gated: the whole chord chopped on the trance gate mask", () => {
    const notes = renderArpSpan("gated", voicing, 4);
    const steps = [...new Set(notes.map((n) => n.startBeat * 4))];
    expect(steps).toEqual([...GATE_MASK].flatMap((c, i) => (c === "x" ? [i] : [])));
    expect(notes).toHaveLength(steps.length * 3);
  });

  it("every note ends before the next 16th (no same-pitch overlaps)", () => {
    for (const style of ["up", "down", "updown", "gated"] as const) {
      for (const n of renderArpSpan(style, voicing, 4)) expect(n.durationBeats).toBeLessThan(0.25);
    }
  });
});
