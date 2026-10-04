// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGbSong } from "./gb-song.js";

const song = {
  title: "Ascent", tempo: 132, style: "orbit-ambient",
  sections: [{ name: "intro", bars: 2 }, { name: "drop", bars: 2 }],
  tracks: [
    { name: "Drums", role: "drums", parts: { drop: { grid: { kick: "x...x...x...x..." } } } },
    { name: "Strings", role: "pad", parts: { intro: { chords: "Fm | Db", style: "sustain" }, drop: { chords: "Ab | Eb", style: "sustain" } } },
    { name: "Lead", role: "lead", parts: { drop: { notes: "f5@2 ab5 c6 | eb6@3 c6" } } },
  ],
};

let workspace: string;
let gbSong: ReturnType<typeof createGbSong>;
beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "gbmcp-"));
  gbSong = createGbSong({ workspaceDir: workspace });
});

describe("gb_song validate", () => {
  it("returns failed SONG_INVALID with the offending path for a malformed song", async () => {
    const r = await gbSong({ command: "validate", song: { ...song, tempo: 999 } });
    expect(r).toMatchObject({ status: "failed", op: "gb_song.validate", error: "SONG_INVALID", write_attempted: false, recoverable: true });
    expect(r.status === "failed" && r.message).toContain("tempo");
  });

  it("returns verified with musical issues and a summary for a valid song", async () => {
    const r = await gbSong({ command: "validate", song });
    expect(r.status).toBe("verified");
    if (r.status !== "verified") return;
    expect(r.data).toMatchObject({
      issues: [],
      summary: { bars: 4, durationSec: 7.27, tracks: [
        { name: "Drums", program: 24, patch: "Boutique 808" },
        { name: "Strings", program: 48, patch: "String Ensemble" },
        { name: "Lead", program: 81, patch: "Soft Saw Lead" },
      ] },
    });
  });
});

describe("gb_song preview", () => {
  it("returns the ASCII grid for a section", async () => {
    const r = await gbSong({ command: "preview", song, section: "drop", maxBars: 1 });
    expect(r.status).toBe("verified");
    if (r.status === "verified") expect((r.data as { grid: string }).grid.split("\n")[1]).toBe("Drums kick       |x...x...x...x...|");
  });
});

describe("gb_song render_midi", () => {
  it("writes a humanized SMF into the workspace and reports what GarageBand will load", async () => {
    const r = await gbSong({ command: "render_midi", song, filename: "ascent.mid" });
    expect(r.status).toBe("verified");
    const path = join(workspace, "ascent.mid");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path).subarray(0, 4).toString()).toBe("MThd");
    if (r.status === "verified") expect(r.data).toMatchObject({ path, tracks: [{ name: "Drums", patch: "Boutique 808" }, {}, {}] });
  });

  it("dry_run writes nothing and returns the plan", async () => {
    const r = await gbSong({ command: "render_midi", song, filename: "ascent.mid", dry_run: true });
    expect(r).toMatchObject({ status: "verified", data: { dry_run: true, path: join(workspace, "ascent.mid") } });
    expect(readdirSync(workspace)).toEqual([]);
  });

  it("never overwrites: an existing file fails with FILE_EXISTS and is left untouched", async () => {
    writeFileSync(join(workspace, "ascent.mid"), "keep me");
    const r = await gbSong({ command: "render_midi", song, filename: "ascent.mid" });
    expect(r).toMatchObject({ status: "failed", error: "FILE_EXISTS", write_attempted: false, safe_to_retry: true });
    expect(readFileSync(join(workspace, "ascent.mid"), "utf8")).toBe("keep me");
  });

  it.each(["../escape.mid", "/etc/x.mid", "a/b.mid", "song.txt", "%2e%2e.mid", "x?.mid", "with\nnewline.mid", ".hidden.mid"])(
    "rejects unsafe filename %j with PATH_INVALID",
    async (filename) => {
      const r = await gbSong({ command: "render_midi", song, filename });
      expect(r).toMatchObject({ status: "failed", error: "PATH_INVALID", write_attempted: false });
      expect(readdirSync(workspace)).toEqual([]);
    },
  );

  it("refuses to render a song with musical errors, returning the issues", async () => {
    const flute = { ...song, style: "acoustic", tracks: [{ name: "Lead", role: "lead", parts: { drop: { notes: "f7" } } }] };
    const r = await gbSong({ command: "render_midi", song: flute, filename: "flute.mid" });
    expect(r).toMatchObject({ status: "failed", error: "VALIDATION_FAILED", write_attempted: false });
    expect(readdirSync(workspace)).toEqual([]);
  });
});

describe("gb_song input", () => {
  it("rejects an unknown command with the valid list", async () => {
    const r = await gbSong({ command: "delete_everything" });
    expect(r).toMatchObject({ status: "failed", error: "INPUT_INVALID" });
    expect(r.status === "failed" && r.message).toContain("validate");
  });
});

describe("gb_song render_draft (macOS GM synth, no GarageBand)", () => {
  type Ev = { duration_s: number; events: { t: number; bytes: number[] }[] };
  const fakeRenderer = () => {
    const calls: { events: Ev; out: string }[] = [];
    return {
      calls,
      port: { async render(events: Ev, out: string) { calls.push({ events, out }); writeFileSync(out, "RIFF"); return { ok: true as const, value: { path: out, seconds: 9.27, peak: 0.6 } }; } },
    };
  };

  it("renders the humanized song to a WAV in the workspace and labels it a draft", async () => {
    const r1 = fakeRenderer();
    const tool = createGbSong({ workspaceDir: workspace, gmRenderer: r1.port });
    const r = await tool({ command: "render_draft", song, filename: "ascent-draft.wav" });
    expect(r.status).toBe("verified");
    expect(r1.calls[0]!.out).toBe(join(workspace, "ascent-draft.wav"));
    expect(r1.calls[0]!.events.events.some((e) => e.bytes[0] === 0xc9)).toBe(true); // drums program on channel 10
    if (r.status === "verified") expect(r.data).toMatchObject({ path: join(workspace, "ascent-draft.wav"), seconds: 9.27, draft: true });
  });

  it("dry_run validates and plans the draft without rendering or writing anything", async () => {
    const r1 = fakeRenderer();
    const tool = createGbSong({ workspaceDir: workspace, gmRenderer: r1.port });
    const r = await tool({ command: "render_draft", song, filename: "plan-draft.wav", dry_run: true });
    expect(r).toMatchObject({ status: "verified", data: { dry_run: true, path: join(workspace, "plan-draft.wav") } });
    expect(r1.calls).toHaveLength(0);
    expect(existsSync(join(workspace, "plan-draft.wav"))).toBe(false);
  });

  it("only accepts safe .wav names and never overwrites", async () => {
    const r1 = fakeRenderer();
    const tool = createGbSong({ workspaceDir: workspace, gmRenderer: r1.port });
    expect(await tool({ command: "render_draft", song, filename: "../x.wav" })).toMatchObject({ status: "failed", error: "PATH_INVALID" });
    writeFileSync(join(workspace, "taken.wav"), "keep");
    expect(await tool({ command: "render_draft", song, filename: "taken.wav" })).toMatchObject({ status: "failed", error: "FILE_EXISTS" });
    expect(r1.calls).toHaveLength(0);
  });

  it("reports DEPENDENCY_MISSING when the renderer is not available", async () => {
    const r = await createGbSong({ workspaceDir: workspace })({ command: "render_draft", song, filename: "a.wav" });
    expect(r).toMatchObject({ status: "failed", error: "DEPENDENCY_MISSING" });
  });
});

describe("gb_song band_plan (M7: audio clips → gb_band build)", () => {
  const withVox = { ...song, tracks: [...song.tracks, { name: "Vox", role: "lead", parts: {}, donorTrack: 1, audio: [{ wav: "stems/vox.wav", section: "drop", beat: 2 }] }] };
  it("returns gb_band build's audio list (absolute bar and beat) and writes nothing", async () => {
    const r = await gbSong({ command: "band_plan", song: withVox });
    expect(r).toMatchObject({ status: "verified", op: "gb_song.band_plan", data: { audio: [{ wav: "stems/vox.wav", bar: 3, beat: 2, track: 1 }] } });
    expect(readdirSync(workspace)).toEqual([]);
  });
  it("render_midi leaves the audio clips out and says so in warnings", async () => {
    const r = await gbSong({ command: "render_midi", song: withVox, filename: "vox.mid", dry_run: true });
    expect(r).toMatchObject({ status: "verified" });
    expect(r.status === "verified" && r.warnings).toEqual(expect.arrayContaining([expect.stringContaining("band_plan")]));
  });
  it("render_draft leaves the audio clips out and says so in warnings", async () => {
    const port = { async render() { return { ok: true as const, value: { path: "", seconds: 0, peak: 0 } }; } };
    const r = await createGbSong({ workspaceDir: workspace, gmRenderer: port })({ command: "render_draft", song: withVox, filename: "vox.wav", dry_run: true });
    expect(r).toMatchObject({ status: "verified" });
    expect(r.status === "verified" && r.warnings).toEqual(expect.arrayContaining([expect.stringContaining("band_plan")]));
  });
  it("refuses a song without audio clips (NOT_SUPPORTED): it is a MIDI song, render_midi makes it", async () => {
    expect(await gbSong({ command: "band_plan", song })).toMatchObject({ status: "failed", error: "NOT_SUPPORTED" });
  });
});

describe("gb_song template (M9: genre knowledge as rules)", () => {
  it("returns a complete, valid Song JSON draft for a genre in a key and tempo, and writes nothing", async () => {
    const r = await gbSong({ command: "template", genre: "deep house", key: "F minor", bpm: 122 });
    expect(r).toMatchObject({ status: "verified", op: "gb_song.template", data: { song: { tempo: 122, key: "F minor", groove: "dance" } } });
    const v = await gbSong({ command: "validate", song: (r as { data: { song: unknown } }).data.song });
    expect(v).toMatchObject({ status: "verified" });
    expect(readdirSync(workspace)).toEqual([]);
  });

  it("refuses an unknown genre with the known ones in the hint", async () => {
    const r = await gbSong({ command: "template", genre: "polka", key: "C major" });
    expect(r).toMatchObject({ status: "failed", error: "INPUT_INVALID" });
    expect(JSON.stringify(r)).toContain("drum and bass");
  });
});

describe("gb_song infill (M10): AMT rewrites chosen tracks of one section", () => {
  const two = {
    title: "Infill", tempo: 120, key: "C major",
    sections: [{ name: "a", bars: 2 }, { name: "b", bars: 2 }],
    tracks: [
      { name: "Drums", role: "drums", parts: { a: { grid: { kick: "x...x...x...x..." } }, b: { grid: { kick: "x...x...x...x..." } } } },
      { name: "Keys", role: "pad", program: 4, parts: { a: { chords: "C | G", style: "sustain" }, b: { chords: "Am | F", style: "sustain" } } },
      { name: "Bass", role: "bass", program: 33, parts: { a: { chords: "C | G", style: "sustain" }, b: { chords: "Am | F", style: "sustain" } } },
    ],
  };
  const sidecar = (notes: unknown[], calls: unknown[] = []) => ({
    calls, async run(model: string, inputs: Record<string, unknown>) { calls.push({ model, inputs }); return { ok: true as const, value: { notes, mode: inputs.mode } }; }, close() {},
  });

  it("asks the sidecar for the section's span and the tracks' instruments, and returns the song with those parts rewritten", async () => {
    const s = sidecar([{ instrument: 4, pitch: 69, start_s: 4.0, dur_s: 1.0 }, { instrument: 4, pitch: 65, start_s: 6.0, dur_s: 2.0 }]);
    const r = await createGbSong({ workspaceDir: workspace, models: s })({ command: "infill", song: two, section: "b", tracks: ["Keys"] });
    expect(s.calls).toEqual([{ model: "infill", inputs: expect.objectContaining({ start_s: 4, end_s: 8, instruments: [4], mode: "exact", seed: 1 }) }]);
    expect(r).toMatchObject({ status: "verified", op: "gb_song.infill", data: { changed: [{ track: "Keys", section: "b" }] } });
    const song = (r as { data: { song: typeof two } }).data.song;
    expect(song.tracks[1]!.parts.b).toEqual({ notes: "a4@8 ~ ~ ~ ~ ~ ~ ~ ~ | f4@16" });
    expect(song.tracks[1]!.parts.a).toEqual(two.tracks[1]!.parts.a); // the other section is untouched
    expect(song.tracks[2]).toEqual(two.tracks[2]);                   // and so are the other tracks
    expect((await gbSong({ command: "validate", song })).status).toBe("verified");
    expect(readdirSync(workspace)).toEqual([]);
  });

  it.each([
    ["a drums track", { section: "b", tracks: ["Drums"] }, "INPUT_INVALID"],
    ["an unknown section", { section: "z", tracks: ["Keys"] }, "INPUT_INVALID"],
    ["an unknown track", { section: "b", tracks: ["Lead"] }, "INPUT_INVALID"],
  ])("refuses %s", async (_why, args, code) => {
    const r = await createGbSong({ workspaceDir: workspace, models: sidecar([]) })({ command: "infill", song: two, ...args });
    expect(r).toMatchObject({ status: "failed", error: code });
  });

  it("refuses two tracks on the same instrument (the model could not tell them apart)", async () => {
    const same = { ...two, tracks: [...two.tracks, { name: "Keys2", role: "pad", program: 4, parts: { b: { chords: "Am", style: "stabs" } } }] };
    const r = await createGbSong({ workspaceDir: workspace, models: sidecar([]) })({ command: "infill", song: same, section: "b", tracks: ["Keys", "Keys2"] });
    expect(r).toMatchObject({ status: "failed", error: "INPUT_INVALID" });
  });

  it("without the model sidecar: DEPENDENCY_MISSING", async () => {
    const r = await gbSong({ command: "infill", song: two, section: "b", tracks: ["Keys"] });
    expect(r).toMatchObject({ status: "failed", error: "DEPENDENCY_MISSING" });
  });
});
