// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { openLoopsDb } from "./loops.js";

const FIXTURE = fileURLToPath(new URL("../../test/fixtures/sound/loops-fixture.db", import.meta.url));
const opened = openLoopsDb(FIXTURE);
if (!opened.ok) throw new Error(opened.error);
const db = opened.value;
afterAll(() => db.close());
const onDisk = new Set(["/Library/Audio/Apple Loops/Apple/Trance Gate Synth.caf"]);
const exists = (p: string) => onDisk.has(p);

describe("loops: open + entry shape", () => {
  it("returns entries with exact 64-bit ids, readable key, decoded path and file presence", () => {
    const out = db.query({ query: "trance" }, { limit: 10, offset: 0 }, { exists });
    expect(out.ok && out.value).toEqual({
      total: 1,
      items: [{
        id: "102", name: "Trance Gate Synth", pack: "Dancefloor Rush", key: "A minor", scale: "minor", tempo: 128,
        beats: 16, lengthSec: 7.5, timeSignature: "4/4", hasMidi: true, instrument: "Keyboards", subInstrument: "Synthesizer",
        genre: "Electronic/Dance", descriptors: ["Grooving", "Electric", "Processed"],
        path: "/Library/Audio/Apple Loops/Apple/Trance Gate Synth.caf", fileExists: true,
      }],
    });
  });

  it("keeps 64-bit ids exact (they exceed JavaScript's safe integers)", () => {
    const out = db.query({ query: "uptown" }, { limit: 10, offset: 0 }, { exists });
    expect(out.ok && out.value.items[0]!.id).toBe("-9223043008183248613");
  });

  it("reports missing keys and tempos as null, not 0 or -1", () => {
    const out = db.query({ query: "four on the floor" }, { limit: 10, offset: 0 }, { exists });
    expect(out.ok && out.value.items[0]).toMatchObject({ key: null, scale: null, tempo: null, fileExists: false });
  });

  it("fails cleanly when the database file is missing", () => {
    expect(openLoopsDb("/nonexistent/LoopsDatabaseV10.db").ok).toBe(false);
  });
});

describe("loops: filters (all parameterized)", () => {
  const names = (filter: Parameters<typeof db.query>[0]) => {
    const out = db.query(filter, { limit: 50, offset: 0 }, { exists });
    if (!out.ok) throw new Error(out.error);
    return out.value.items.map((i) => i.name);
  };

  it("key accepts 'F minor', 'Fm' and 'F min' (root + scale)", () => {
    expect(names({ key: "F minor" })).toEqual(["Dark's 'Edge' % Bass", "Phantom Pulse Bass"]);
    expect(names({ key: "Fm" })).toEqual(names({ key: "F minor" }));
    expect(names({ key: "G major" })).toEqual(["Uptown Perimeter Melody"]);
  });

  it("tempo range is inclusive and excludes loops without a tempo", () => {
    expect(names({ tempoMin: 128, tempoMax: 140 })).toEqual(["Dark's 'Edge' % Bass", "Phantom Pulse Bass", "Trance Gate Synth"]);
  });

  it("genre, instrument (type or subtype) and pack", () => {
    expect(names({ genre: "electronic/dance" })).toEqual(["Dark's 'Edge' % Bass", "Four On The Floor Beat", "Trance Gate Synth"]);
    expect(names({ instrument: "synthetic bass" })).toEqual(["Dark's 'Edge' % Bass", "Phantom Pulse Bass"]);
    expect(names({ instrument: "Drums" })).toEqual(["Four On The Floor Beat"]);
    expect(names({ pack: "electronic pop" })).toEqual(["Trance Gate Synth"]);
  });

  it("descriptors match whole words only ('Dark' does not match 'Darkest'); all must match", () => {
    expect(names({ descriptors: ["Dark"] })).toEqual(["Phantom Pulse Bass", "Uptown Perimeter Melody"]);
    expect(names({ descriptors: ["dark", "intense"] })).toEqual(["Phantom Pulse Bass"]);
  });

  it("hasMidi filters software-instrument (green) loops", () => {
    expect(names({ hasMidi: true })).toEqual(["Four On The Floor Beat", "Trance Gate Synth"]);
  });

  it("treats quotes, % and _ in a query literally (no injection, no wildcards)", () => {
    expect(names({ query: "Dark's 'Edge' %" })).toEqual(["Dark's 'Edge' % Bass"]);
    expect(names({ query: "%" })).toEqual(["Dark's 'Edge' % Bass"]);
    expect(names({ query: "' OR 1=1 --" })).toEqual([]);
  });

  it("installedOnly keeps only loops whose audio file is on disk, with a correct total", () => {
    const out = db.query({ installedOnly: true }, { limit: 10, offset: 0 }, { exists });
    expect(out.ok && { total: out.value.total, names: out.value.items.map((i) => i.name) })
      .toEqual({ total: 1, names: ["Trance Gate Synth"] });
    const none = db.query({ installedOnly: true, genre: "Dubstep" }, { limit: 10, offset: 0 }, { exists });
    expect(none.ok && none.value.total).toBe(0);
  });

  it("rejects an unparseable key instead of guessing", () => {
    const out = db.query({ key: "H lydian" }, { limit: 10, offset: 0 }, { exists });
    expect(out).toEqual({ ok: false, error: 'key "H lydian" not understood; use e.g. "F minor", "Fm", "Bb major"' });
  });

  it("pages: total counts all matches, items respect limit/offset", () => {
    const out = db.query({}, { limit: 2, offset: 1 }, { exists });
    expect(out.ok && { total: out.value.total, names: out.value.items.map((i) => i.name) })
      .toEqual({ total: 5, names: ["Four On The Floor Beat", "Phantom Pulse Bass"] });
  });
});
