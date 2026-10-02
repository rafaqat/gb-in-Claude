// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { rawToDb, dbToRaw, VOLUME_TAPER } from "./volume-taper.js";

describe("GarageBand fader taper (measured from GarageBand exports)", () => {
  it("maps the measured points: 233 = +6 dB (the Logic-family maximum), 173 = unity, 53 = −18.2 dB", () => {
    expect(rawToDb(233)).toBe(6);
    expect(rawToDb(173)).toBe(0);
    expect(rawToDb(113)).toBe(-6);
    expect(rawToDb(53)).toBe(-18.2);
  });

  it("follows the measured law between points: 0.1 dB/step above raw 113, 0.2 dB/step from 53 to 113", () => {
    expect(rawToDb(143)).toBe(-3);
    expect(rawToDb(83)).toBe(-12.1);
  });

  it("finds the fader position for a gain", () => {
    expect(dbToRaw(-3)).toBe(143);
    expect(dbToRaw(0)).toBe(173);
    expect(dbToRaw(-12)).toBe(83); // halfway between 83 (−12.1) and 84 (−11.9): ties go to the quieter position
  });

  it("refuses to extrapolate: outside −18.2…+6 dB (or below raw 53, where the measurement hit its floor) is null", () => {
    expect(dbToRaw(-20)).toBeNull();
    expect(dbToRaw(6.5)).toBeNull();
    expect(rawToDb(40)).toBeNull();
    expect(VOLUME_TAPER[0]![0]).toBe(53);
  });
});
