// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGbAnalyze } from "./gb-analyze.js";
import type { AnalyzerPort, AnalyzeRequest, AnalysisResult } from "../analysis/analyzer.js";
import type { Result } from "../result.js";

const fakeResult = (flags: string[] = [], lufs = -14): AnalysisResult => ({
  file: { seconds: 8, sample_rate: 44100, channels: 2 },
  loudness: { integrated_lufs: lufs, levels: { sample_peak_dbfs: -1, true_peak_dbtp: -1, rms_dbfs: -15, crest_db: 14, clipped_samples: 0, clip_runs: 0 } },
  tonal_balance: { bands: { sub: { share: 0.2, db: -7 }, low: { share: 0.3, db: -5 }, mid: { share: 0.3, db: -5 }, presence: { share: 0.1, db: -10 }, air: { share: 0.1, db: -10 } }, tilt_db_per_octave: -4, centroid_hz: 800 },
  stereo_width: { mono_source: false, overall: 0.2, bands: { low: 0, mid: 0.2, high: 0.3 } },
  rhythm: { tempo: { bpm: 132, bpm_folded: null, relation_to_intended: null, matches_intended: null, confidence: 0.5 }, onset_density: 4, pump: { detected: null, depth_db: null, trough_phase: null, peak_phase: null, strength: null } },
  drums: { percussive_ratio_db: -11, kick_band_share: 0.3 },
  key: { estimated: "F minor", confidence: 0.1, declared: null, relation: null },
  sections: [], missing_sections: [],
  section_contrast: { loudest: null, quietest: null, range_lu: null, drop_minus_breakdown_lu: null },
  thresholds: { thin_low_end_share: 0.2 }, flags, suggestions: [], spectrogram: null,
});

class FakeAnalyzer implements AnalyzerPort {
  requests: AnalyzeRequest[] = [];
  constructor(private reply: (req: AnalyzeRequest) => Result<AnalysisResult, { code: never; message: string }> | Result<AnalysisResult, { code: string; message: string }>) {}
  async analyze(req: AnalyzeRequest) {
    this.requests.push(req);
    return this.reply(req) as Awaited<ReturnType<AnalyzerPort["analyze"]>>;
  }
}

const song = {
  title: "Ascent", tempo: 132, key: "F minor",
  sections: [{ name: "breakdown", bars: 2 }, { name: "drop", bars: 2 }],
  tracks: [{ name: "Bass", role: "bass", parts: { drop: { chords: "Fm", style: "offbeat" } } }],
};

let ws: string;
beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), "gbmcp-ga-")));
  mkdirSync(join(ws, "exports"));
  writeFileSync(join(ws, "exports", "mix.wav"), "RIFF");
  writeFileSync(join(ws, "exports", "mix-v2.wav"), "RIFF");
});

const ok = (r: AnalysisResult) => ({ ok: true as const, value: r });

describe("gb_analyze audio", () => {
  it("analyzes a workspace file, writes the spectrogram under analysis/, and omits static thresholds by default", async () => {
    const analyzer = new FakeAnalyzer((req) => ok({ ...fakeResult(), spectrogram: req.spectrogramPath ?? null }));
    const r = await createGbAnalyze({ workspaceDir: ws, analyzer })({ command: "audio", path: "exports/mix.wav" });
    expect(r.status).toBe("verified");
    expect(analyzer.requests[0]).toEqual({ path: join(ws, "exports", "mix.wav"), spectrogramPath: join(ws, "analysis", "mix.png") });
    if (r.status !== "verified") return;
    const data = r.data as Record<string, unknown>;
    expect(data.spectrogram).toBe(join(ws, "analysis", "mix.png"));
    expect(data).not.toHaveProperty("thresholds");
    expect(data).toHaveProperty("suggestions");
  });

  it("never reuses a spectrogram name: picks mix-2.png when mix.png exists", async () => {
    mkdirSync(join(ws, "analysis"));
    writeFileSync(join(ws, "analysis", "mix.png"), "old");
    const analyzer = new FakeAnalyzer(() => ok(fakeResult()));
    await createGbAnalyze({ workspaceDir: ws, analyzer })({ command: "audio", path: "exports/mix.wav" });
    expect(analyzer.requests[0]!.spectrogramPath).toBe(join(ws, "analysis", "mix-2.png"));
  });

  it("spectrogram: false skips the image; fields masks the response", async () => {
    const analyzer = new FakeAnalyzer(() => ok(fakeResult(["thin_low_end"])));
    const r = await createGbAnalyze({ workspaceDir: ws, analyzer })({ command: "audio", path: "exports/mix.wav", spectrogram: false, fields: ["flags", "loudness", "drums"] });
    expect(analyzer.requests[0]!.spectrogramPath).toBeUndefined();
    expect(r.status === "verified" && Object.keys(r.data as object).sort()).toEqual(["drums", "flags", "loudness"]);
  });

  it("rejects unknown fields with the allowed list", async () => {
    const r = await createGbAnalyze({ workspaceDir: ws, analyzer: new FakeAnalyzer(() => ok(fakeResult())) })(
      { command: "audio", path: "exports/mix.wav", fields: ["vibes"] });
    expect(r).toMatchObject({ status: "failed", error: "INPUT_INVALID" });
  });

  it.each([
    ["/etc/hosts.wav", "PATH_OUTSIDE_WORKSPACE"],
    ["%2e%2e/x.wav", "PATH_INVALID"],
    ["exports/none.wav", "FILE_NOT_FOUND"],
  ])("maps path problems (%s → %s) without running the analyzer", async (path, code) => {
    const analyzer = new FakeAnalyzer(() => ok(fakeResult()));
    const r = await createGbAnalyze({ workspaceDir: ws, analyzer })({ command: "audio", path });
    expect(r).toMatchObject({ status: "failed", error: code, write_attempted: false });
    expect(analyzer.requests).toHaveLength(0);
  });

  it("maps analyzer failures, with a doctor hint for missing dependencies", async () => {
    const analyzer = new FakeAnalyzer(() => ({ ok: false, error: { code: "DEPENDENCY_MISSING", message: "python dependency missing: scipy" } }));
    const r = await createGbAnalyze({ workspaceDir: ws, analyzer })({ command: "audio", path: "exports/mix.wav" });
    expect(r).toMatchObject({ status: "failed", error: "DEPENDENCY_MISSING" });
    expect(r.status === "failed" && r.hint).toContain("gb_system");
  });
});

describe("gb_analyze against_song", () => {
  it("passes the song's bar map, tempo, key and track roles as analysis context", async () => {
    const analyzer = new FakeAnalyzer(() => ok(fakeResult()));
    const r = await createGbAnalyze({ workspaceDir: ws, analyzer })({ command: "against_song", path: "exports/mix.wav", song, spectrogram: false });
    expect(r.status).toBe("verified");
    expect(analyzer.requests[0]!.context).toEqual({
      title: "Ascent", tempo: 132, beats_per_bar: 4, key: "F minor", style: null,
      sections: [{ name: "breakdown", bars: 2 }, { name: "drop", bars: 2 }],
      tracks: [{ name: "Bass", role: "bass", sections: ["drop"] }],
    });
  });

  it("refuses an invalid song before analyzing", async () => {
    const analyzer = new FakeAnalyzer(() => ok(fakeResult()));
    const r = await createGbAnalyze({ workspaceDir: ws, analyzer })({ command: "against_song", path: "exports/mix.wav", song: { title: "x" } });
    expect(r).toMatchObject({ status: "failed", error: "SONG_INVALID" });
    expect(analyzer.requests).toHaveLength(0);
  });
});

describe("gb_analyze compare", () => {
  it("analyzes both exports (no images) and reports deltas, resolved flags and a verdict", async () => {
    const analyzer = new FakeAnalyzer((req) => ok(req.path.endsWith("mix.wav") ? fakeResult(["thin_low_end"], -18) : fakeResult([], -14)));
    const r = await createGbAnalyze({ workspaceDir: ws, analyzer })({ command: "compare", before: "exports/mix.wav", after: "exports/mix-v2.wav" });
    expect(analyzer.requests.map((q) => q.spectrogramPath)).toEqual([undefined, undefined]);
    expect(r).toMatchObject({ status: "verified", data: { verdict: "improved", resolved: ["thin_low_end"], deltas: { integrated_lufs: 4 } } });
  });
});

describe("gb_analyze: strict commands", () => {
  it("a parameter that does not belong to the command is INPUT_INVALID, not silently dropped", async () => {
    const r = await createGbAnalyze({ workspaceDir: mkdtempSync(join(tmpdir(), "gbmcp-an-")), analyzer: { analyze: async () => { throw new Error("must not run"); } } as never })(
      { command: "compare", before: "a.wav", after: "b.wav", fields: ["loudness"] });
    expect(r).toMatchObject({ status: "failed", error: "INPUT_INVALID" });
  });
});
