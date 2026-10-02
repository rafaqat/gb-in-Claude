// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { parsePitch } from "./pitch.js";

describe("parsePitch", () => {
  it("parses a natural note with octave (C4 = 60)", () => {
    expect(parsePitch("c4")).toEqual({ ok: true, value: 60 });
  });

  it("parses other letters and octaves (F5 = 77, A0 = 21)", () => {
    expect(parsePitch("f5")).toEqual({ ok: true, value: 77 });
    expect(parsePitch("a0")).toEqual({ ok: true, value: 21 });
  });

  it("parses sharps (#) and flats (b), case-insensitive (Eb6 = 87, C#3 = 49)", () => {
    expect(parsePitch("eb6")).toEqual({ ok: true, value: 87 });
    expect(parsePitch("C#3")).toEqual({ ok: true, value: 49 });
  });

  it.each(["", "h4", "c", "c10", "cb#4", "c 4", "60", "a#9", "g#9", "c-2"])(
    "rejects invalid or out-of-MIDI-range pitch %j",
    (input) => {
      expect(parsePitch(input)).toEqual({ ok: false, error: { code: "INVALID_PITCH", input } });
    },
  );

  it("accepts the MIDI range edges (C-1 = 0, G9 = 127)", () => {
    expect(parsePitch("c-1")).toEqual({ ok: true, value: 0 });
    expect(parsePitch("g9")).toEqual({ ok: true, value: 127 });
  });
});
