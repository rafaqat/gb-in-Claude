// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { displayName, displayCategory, scanPatchLibrary, filterPatches } from "./patches.js";

const lib = (sub: string) => fileURLToPath(new URL(`../../test/fixtures/sound/patches/${sub}`, import.meta.url));
const roots = [{ dir: lib("factory"), source: "factory" as const }, { dir: lib("user"), source: "user" as const }];
const RECEIPTS = ["com.apple.pkg.MAContent10_AssetPack_0815_EXS_ElectronicDrumkitsHardwellHeavyIndustry"];

describe("patch naming (as GarageBand 10.4.14's Library shows it)", () => {
  it.each([
    ["Epic Electro GB", "Epic Electro"], // file "Epic Electro GB.patch" shows as "Epic Electro" on the track header
    ["Taureg Moon Bass", "Taureg Moon Bass"],
    ["GB Funk", "GB Funk"], // only a trailing " GB" is a suffix
  ])("display name of %j is %j", (stem, name) => {
    expect(displayName(stem)).toBe(name);
  });

  it("category drops the zNN sort prefixes GarageBand hides (z01 Arpeggiator → Arpeggiator)", () => {
    expect(displayCategory(["z01 Arpeggiator", "Synth Basics"])).toBe("Arpeggiator > Synth Basics");
    expect(displayCategory(["Drum Kit", "z01 Multi-Channel Kits"])).toBe("Drum Kit > Multi-Channel Kits");
    expect(displayCategory([])).toBe("");
  });

  it("also drops plain NN sort prefixes used on Audio patch folders (04 Voice → Voice)", () => {
    expect(displayCategory(["Electric Guitar and Bass", "01 Clean Guitar"])).toBe("Electric Guitar and Bass > Clean Guitar");
    expect(displayCategory(["04 Voice", "z01 Experimental"])).toBe("Voice > Experimental");
    expect(displayCategory(["808 Kits"])).toBe("808 Kits"); // digits that are part of a name stay
  });
});

describe("scanPatchLibrary", () => {
  const scan = () => {
    const out = scanPatchLibrary(roots, { receipts: RECEIPTS });
    if (!out.ok) throw new Error(out.error);
    return out.value;
  };

  it("indexes every .patch with display name, category, kind and source; skips symlinks", () => {
    expect(scan().map((p) => [p.kind, p.category, p.name, p.source])).toEqual([
      ["audio", "Voice", "Natural Vocal", "factory"],
      ["instrument", "", "My Lead", "user"],
      ["instrument", "Arpeggiator > Synth Basics", "Pulse Arp", "factory"],
      ["drum_kit", "Electronic Drum Kit", "Epic Electro", "factory"],
      ["instrument", "Synthesizer > Bass", "Taureg Moon Bass", "factory"],
      ["instrument", "Synthesizer > Lead", "Soft Saw Lead", "factory"],
      ["output", "", "Master Track", "factory"],
    ]);
  });

  it("reports required content packs and install evidence from package receipts", () => {
    const byName = Object.fromEntries(scan().map((p) => [p.name, p]));
    expect(byName["Taureg Moon Bass"]).toMatchObject({ packs: [], content: "base" });
    expect(byName["Epic Electro"]).toMatchObject({ packs: ["Hardwell"], content: "receipt_found" });
    expect(byName["Pulse Arp"]).toMatchObject({ packs: ["Watch the Sound"], content: "no_receipt_match" });
  });

  it("cross-links GM programs that select the patch when a MIDI file is opened (no UI needed)", () => {
    const byName = Object.fromEntries(scan().map((p) => [p.name, p]));
    expect(byName["Taureg Moon Bass"]).toMatchObject({ gmPrograms: [39], gmDrumKits: [] });
    expect(byName["Soft Saw Lead"]).toMatchObject({ gmPrograms: [81] });
    expect(byName["Epic Electro"]).toMatchObject({ gmPrograms: [], gmDrumKits: [16] });
    expect(byName["Pulse Arp"]).toMatchObject({ gmPrograms: [], gmDrumKits: [] });
  });

  it("reports content 'unknown' (not a false 'no_receipt_match') when receipts couldn't be read", () => {
    const out = scanPatchLibrary(roots, { receipts: null });
    const byName = Object.fromEntries((out.ok ? out.value : []).map((p) => [p.name, p]));
    expect(byName["Epic Electro"]!.content).toBe("unknown");
    expect(byName["Taureg Moon Bass"]!.content).toBe("base");
  });

  it("returns an error (not a throw) when no root exists", () => {
    expect(scanPatchLibrary([{ dir: "/nonexistent/gb", source: "factory" }], { receipts: [] }).ok).toBe(false);
  });
});

describe("filterPatches", () => {
  const all = (() => {
    const out = scanPatchLibrary(roots, { receipts: RECEIPTS });
    if (!out.ok) throw new Error(out.error);
    return out.value;
  })();
  const names = (f: Parameters<typeof filterPatches>[1]) => filterPatches(all, f).map((p) => p.name);

  it("query matches name case-insensitively", () => expect(names({ query: "saw" })).toEqual(["Soft Saw Lead"]));
  it("category matches a prefix of the display path", () => expect(names({ category: "synthesizer" })).toEqual(["Taureg Moon Bass", "Soft Saw Lead"]));
  it("kind filters drum kits", () => expect(names({ kind: "drum_kit" })).toEqual(["Epic Electro"]));
  it("gmReachable keeps patches a GM program can load with no UI", () =>
    expect(names({ gmReachable: true })).toEqual(["Epic Electro", "Taureg Moon Bass", "Soft Saw Lead"]));
  it("source filters user patches", () => expect(names({ source: "user" })).toEqual(["My Lead"]));
});
