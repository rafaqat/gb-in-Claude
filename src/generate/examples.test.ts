// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExamples, rankExamples } from "./examples.js";

let dir: string;
const ex = (name: string, caption: string, language: string, lyrics: string, bpm = 120) =>
  writeFileSync(join(dir, `${name}.json`), JSON.stringify({ think: true, caption, lyrics, bpm, duration: 120, keyscale: "A minor", language, timesignature: "4" }));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ace-examples-"));
  ex("example_1", "A nostalgic synthwave track for a night drive, arpeggiated synth bass and gated drums.", "en", "[Intro - Synth Arpeggio]\n\n[Verse 1 - Instrumental]\n\n[Chorus - Instrumental]", 110);
  ex("example_2", "A tender piano ballad with a soft female vocal and gentle strings.", "en", "[Verse 1]\nI kept your letters by the door\n\n[Chorus]\nStay a little longer", 72);
  ex("example_3", "An energetic J-pop anthem with bright synths and a powerful female vocal.", "ja", "[Verse 1]\n光の中で\n\n[Chorus]\n走り出そう", 150);
  ex("example_4", "A heavy metal track with distorted guitars, double kick drums and a raspy male vocal.", "en", "[Intro - Guitar Riff]\n\n[Verse 1]\nBreak the chains", 160);
  writeFileSync(join(dir, "notes.txt"), "not an example");
});

describe("ACE-Step's own examples as many-shot prompts for a request", () => {
  it("loads every example JSON (and skips other files)", () => {
    const all = loadExamples(dir);
    expect(all.ok && all.value.map((e) => e.id).sort()).toEqual(["example_1", "example_2", "example_3", "example_4"]);
  });

  it("ranks by how well the caption fits the request", () => {
    const all = loadExamples(dir);
    if (!all.ok) throw new Error();
    expect(rankExamples(all.value, { query: "synthwave night drive" })[0]!.id).toBe("example_1");
    expect(rankExamples(all.value, { query: "a sad piano ballad with female vocals" })[0]!.id).toBe("example_2");
  });

  it("filters by vocal language and keeps to the limit", () => {
    const all = loadExamples(dir);
    if (!all.ok) throw new Error();
    expect(rankExamples(all.value, { query: "female vocal", language: "ja" }).map((e) => e.id)).toEqual(["example_3"]);
    expect(rankExamples(all.value, { query: "vocal", limit: 2 })).toHaveLength(2);
  });

  it("instrumental ranks instrumental examples first but never comes back empty (ACE-Step's 200 examples all have lyrics)", () => {
    const all = loadExamples(dir);
    if (!all.ok) throw new Error();
    const r = rankExamples(all.value, { query: "piano ballad", instrumental: true, limit: 3 });
    expect(r[0]!.id).toBe("example_1"); // the only instrumental one, first
    expect(r).toHaveLength(3);
    expect(rankExamples(all.value.filter((e) => !e.instrumental), { query: "piano", instrumental: true }).length).toBeGreaterThan(0);
  });

  it("a folder that is not there is a typed error", () => {
    expect(loadExamples(join(dir, "none"))).toMatchObject({ ok: false });
  });
});
