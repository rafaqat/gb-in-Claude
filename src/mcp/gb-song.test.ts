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
