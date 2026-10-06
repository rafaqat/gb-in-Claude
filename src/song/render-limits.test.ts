// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { parseSong } from "./schema.js";
import { renderSong, MAX_NOTES } from "./render.js";

// commit security review 2026-10-06: a short pattern loops to fill its section, so string limits alone do not bound
// the work — a 128-note bar over 2048 bars renders 262 144 notes. The renderer counts and stops.
describe("renderSong: a bound on the notes it renders", () => {
  it(`refuses a song that would render more than ${MAX_NOTES} notes`, () => {
    const p = parseSong({ title: "t", tempo: 120, humanize: "off",
      sections: Array.from({ length: 8 }, (_, i) => ({ name: `s${i}`, bars: 256 })),
      tracks: [{ name: "Lead", role: "lead", parts: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`s${i}`, { notes: "c5 ".repeat(128).trim() }])) }] });
    if (!p.ok) throw new Error(p.error.message);
    expect(renderSong(p.value)).toMatchObject({ ok: false, error: { code: "RENDER_FAILED" } });
  });

  it("the bound is far above a real song", () => {
    expect(MAX_NOTES).toBeGreaterThanOrEqual(200_000);
  });
});
