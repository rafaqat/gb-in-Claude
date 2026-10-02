// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { STYLES, resolveProgram } from "./styles.js";

describe("style presets (programs chosen by ear)", () => {
  it.each([
    ["club-trance", { drums: 16, bass: 39, pad: 90, arp: 81, lead: 127, "lead-high": 84, fx: 96 }],
    ["acoustic", { drums: 0, bass: 33, pad: 48, arp: 0, lead: 73, "lead-high": 9, fx: 48 }],
    ["orbit-ambient", { drums: 24, bass: 39, pad: 48, arp: 98, lead: 81, "lead-high": 54, fx: 99 }],
  ] as const)("%s maps every role to its approved GM program", (style, programs) => {
    expect(STYLES[style].programs).toEqual(programs);
  });

  it("orbit-ambient suggests 126 BPM; the others leave tempo to the song", () => {
    expect(STYLES["orbit-ambient"].suggestedTempo).toBe(126);
    expect(STYLES["club-trance"].suggestedTempo).toBeUndefined();
  });
});

describe("resolveProgram", () => {
  it("prefers the track's explicit program over the style", () => {
    expect(resolveProgram("club-trance", { role: "lead", program: 73 })).toBe(73);
  });
  it("uses the style's program for the role", () => {
    expect(resolveProgram("orbit-ambient", { role: "lead-high" })).toBe(54);
  });
  it("falls back to club-trance when the song has no style", () => {
    expect(resolveProgram(undefined, { role: "bass" })).toBe(39);
  });
});
