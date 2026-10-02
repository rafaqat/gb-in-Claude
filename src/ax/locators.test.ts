// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import {
  parseTrackHeader, parsePianoRollNote, appleNoteToMidi, parseSavePrompt, trackControlLocator,
  locatorsFor, SUPPORTED_GARAGEBAND_VERSIONS, GB_10_4_14,
} from "./locators.js";
import { parseSelector } from "./selector.js";
import { FakeHelper } from "./fake-helper.js";

describe("parseTrackHeader (the description changes with mute/solo state)", () => {
  it.each([
    ["Track 1 “Soft Saw Lead”", { number: 1, name: "Soft Saw Lead", muted: false, soloed: false }],
    ["Track 2 “Taureg Moon Bass”, mute", { number: 2, name: "Taureg Moon Bass", muted: true, soloed: false }],
    ["Track 3 “Epic Cloud Formation”, solo", { number: 3, name: "Epic Cloud Formation", muted: false, soloed: true }],
    ["Track 12 “Lead”, mute, solo", { number: 12, name: "Lead", muted: true, soloed: true }],
  ])("%s", (desc, expected) => {
    expect(parseTrackHeader(desc)).toEqual({ ...expected, description: desc });
  });

  it.each(["Tracks header", "Track one “Lead”", "Track 1 Lead", "Track 1 “Lead”, muted", ""])("rejects %j", (desc) => {
    expect(parseTrackHeader(desc)).toBeUndefined();
  });
});

describe("parsePianoRollNote (Apple octave naming: MIDI 60 = C3)", () => {
  it.each([
    ["Note at 9 bars , C3", { bar: 9, beat: 1, division: 1, name: "C3", midi: 60 }],
    ["Note at 9 bars 2 divisions , F3", { bar: 9, beat: 1, division: 2, name: "F3", midi: 65 }],
    ["Note at 9 bars 2 beats , F4", { bar: 9, beat: 2, division: 1, name: "F4", midi: 77 }],
    ["Note at 9 bars 2 beats 2 divisions , G♯4", { bar: 9, beat: 2, division: 2, name: "G♯4", midi: 80 }],
    ["Note at 10 bars , C♯3", { bar: 10, beat: 1, division: 1, name: "C♯3", midi: 61 }],
  ])("%s", (desc, expected) => {
    expect(parsePianoRollNote(desc)).toEqual(expected);
  });

  it.each(["cycle region", "Note at nine bars , C3", "Note at 9 bars , H3", "Note at 9 bars C3"])("rejects %j", (desc) => {
    expect(parsePianoRollNote(desc)).toBeUndefined();
  });

  it("converts Apple note names (C3 = 60) with sharps and flats", () => {
    expect(appleNoteToMidi("C3")).toBe(60);
    expect(appleNoteToMidi("G♯4")).toBe(80);
    expect(appleNoteToMidi("B♭2")).toBe(58);
    expect(appleNoteToMidi("C-2")).toBe(0);
    expect(appleNoteToMidi("X9")).toBeUndefined();
  });
});

describe("parseSavePrompt", () => {
  it("extracts the document a save prompt is about (to guard Don’t Save)", () => {
    expect(parseSavePrompt("Do you want to save the document “Untitled 2”?")).toBe("Untitled 2");
    expect(parseSavePrompt("Do you want to save the document “Ascent-v4-session.band”?")).toBe("Ascent-v4-session.band");
    expect(parseSavePrompt("If you close the document “Untitled 2” without saving it, it will be deleted.")).toBeUndefined();
  });
});

describe("locator registry", () => {
  it("is keyed by GarageBand version; unknown versions are unsupported", () => {
    expect(SUPPORTED_GARAGEBAND_VERSIONS).toEqual(["10.4.14"]);
    expect(locatorsFor("10.4.14")).toBe(GB_10_4_14);
    expect(locatorsFor("10.4.15")).toBeUndefined();
    expect(locatorsFor(null)).toBeUndefined();
  });

  it("every selector in the registry is a valid exact selector", () => {
    for (const [name, c] of Object.entries(GB_10_4_14.controls)) expect(parseSelector(c.selector).ok, name).toBe(true);
    for (const [name, p] of Object.entries(GB_10_4_14.panels)) {
      if (p.root.element) expect(parseSelector(p.root.element).ok, name).toBe(true);
    }
  });

  it("every main-window control resolves to exactly one element in the 10.4.14 fixtures (fixture state: playing)", async () => {
    const fake = new FakeHelper();
    for (const [name, c] of Object.entries(GB_10_4_14.controls)) {
      if (c.root.kind !== "main_window" || c.evidence === "inferred" || c.requiresState === "stopped") continue;
      const r = await fake.call("ax.find", { root: c.root, selector: c.selector });
      expect(r.ok && (r.value as { count: number }).count, name).toBe(1);
    }
  });

  it("export-panel controls resolve once the panel is open", async () => {
    const fake = new FakeHelper();
    await fake.call("ax.menu", { path: GB_10_4_14.menus["share.export_song_to_disk"]!.path });
    for (const [name, c] of Object.entries(GB_10_4_14.controls)) {
      if (!name.startsWith("export.")) continue;
      const r = await fake.call("ax.find", { root: c.root, selector: c.selector });
      expect(r.ok && (r.value as { count: number }).count, name).toBe(1);
    }
  });

  it("every menu path resolves (dry run) in the live-captured menu bar", async () => {
    const fake = new FakeHelper();
    for (const [name, m] of Object.entries(GB_10_4_14.menus)) {
      expect((await fake.call("ax.menu", { path: m.path, dry_run: true })).ok, name).toBe(true);
    }
  });

  it("every panel root resolves in the fixtures (except panels not captured: piano roll, dialogs)", async () => {
    const fake = new FakeHelper();
    for (const [name, p] of Object.entries(GB_10_4_14.panels)) {
      if (p.root.kind !== "main_window" || p.evidence === "inferred") continue;
      const r = await fake.call("ax.snapshot", { root: p.root, depth: 1 });
      expect(r.ok, `${name}: ${JSON.stringify(r)}`).toBe(true);
    }
  });
});

describe("trackControlLocator", () => {
  it("targets one track's control via its CURRENT exact header description (re-read after mute)", async () => {
    const fake = new FakeHelper();
    const header2 = parseTrackHeader("Track 2 “Taureg Moon Bass”")!;
    const vol = trackControlLocator(header2, "volume");
    expect(await fake.call("ax.find", { root: vol.root, selector: vol.selector })).toMatchObject({ ok: true, value: { count: 1, matches: [{ value: 173 }] } });

    const mute1 = trackControlLocator(parseTrackHeader("Track 1 “Soft Saw Lead”")!, "mute");
    await fake.call("ax.press", { root: mute1.root, selector: mute1.selector });
    const stale = await fake.call("ax.find", { root: mute1.root, selector: mute1.selector });
    expect(stale).toMatchObject({ ok: true, value: { count: 0 } }); // the old description no longer exists

    const fresh = trackControlLocator(parseTrackHeader("Track 1 “Soft Saw Lead”, mute")!, "mute");
    expect(await fake.call("ax.find", { root: fresh.root, selector: fresh.selector })).toMatchObject({ ok: true, value: { count: 1, matches: [{ value: 1 }] } });
  });

  it("pan is the track's slider WITHOUT a description", async () => {
    const pan = trackControlLocator(parseTrackHeader("Track 1 “Soft Saw Lead”")!, "pan");
    expect(pan.selector).toMatchObject({ role: "AXSlider", description: "" });
    expect(await new FakeHelper().call("ax.find", { root: pan.root, selector: pan.selector })).toMatchObject({ ok: true, value: { count: 1, matches: [{ value: 64 }] } });
  });
});

describe("state-dependent controls", () => {
  it("the stop button is “Stop” while playing and “Go to Beginning” while stopped", async () => {
    const fake = new FakeHelper(); // fixture state: playing (Play = 1)
    const count = async (name: string) => {
      const c = GB_10_4_14.controls[name]!;
      const r = await fake.call("ax.find", { root: c.root, selector: c.selector });
      return r.ok ? (r.value as { count: number }).count : -1;
    };
    expect(GB_10_4_14.controls["transport.stop"]!.requiresState).toBe("playing");
    expect(GB_10_4_14.controls["transport.go_to_beginning"]!.requiresState).toBe("stopped");
    expect([await count("transport.stop"), await count("transport.go_to_beginning")]).toEqual([1, 0]);
    await fake.call("ax.press", { root: { kind: "main_window" }, selector: GB_10_4_14.controls["transport.play"]!.selector });
    expect([await count("transport.stop"), await count("transport.go_to_beginning")]).toEqual([0, 1]);
  });
});
