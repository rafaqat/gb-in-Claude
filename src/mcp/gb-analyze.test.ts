// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGbAnalyze } from "./gb-analyze.js";
import type { AnalyzerPort, AnalyzeRequest, AnalysisResult } from "../analysis/analyzer.js";
import type { Result } from "../result.js";
import { bareWav } from "../band/testing.js";
import type { ModelSidecar } from "../models/sidecar.js";

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

describe("gb_analyze: model listening through the sidecar (M8, field ml)", () => {
  const listener = (reply: (model: string, inputs: Record<string, unknown>) => unknown, calls: unknown[] = []) => ({
    calls,
    async run(model: string, inputs: Record<string, unknown>) { calls.push({ model, inputs }); return reply(model, inputs) as never; },
    close() {},
  });
  const heard = { beats: { count: 64, downbeats: 16, bpm: 132 }, key: { key: "F minor" }, genre: { ranking: [{ genre: "techno", similarity: 0.3 }] } };

  it("adds ml (beats, key, genre ranking) from one sidecar request", async () => {
    const l = listener(() => ({ ok: true, value: heard }));
    const r = await createGbAnalyze({ workspaceDir: ws, analyzer: new FakeAnalyzer(() => ok(fakeResult())), listener: l })({ command: "audio", path: "exports/mix.wav", spectrogram: false });
    expect(r).toMatchObject({ status: "verified", data: { ml: heard } });
    expect(l.calls).toEqual([{ model: "listen", inputs: { wav: join(ws, "exports", "mix.wav") } }]);
  });

  it("against_song passes the song's tempo and key, so the sidecar adds the grid check and the key match", async () => {
    const l = listener(() => ({ ok: true, value: heard }));
    await createGbAnalyze({ workspaceDir: ws, analyzer: new FakeAnalyzer(() => ok(fakeResult())), listener: l })({ command: "against_song", path: "exports/mix.wav", song, spectrogram: false });
    expect(l.calls).toEqual([{ model: "listen", inputs: { wav: join(ws, "exports", "mix.wav"), bpm: 132, key: "F minor" } }]);
  });

  it("passes the song's swing, so the grid check expects swung off-beats", async () => {
    const l = listener(() => ({ ok: true, value: heard }));
    await createGbAnalyze({ workspaceDir: ws, analyzer: new FakeAnalyzer(() => ok(fakeResult())), listener: l })({ command: "against_song", path: "exports/mix.wav", song: { ...song, swing: 64, swingUnit: "8th" }, spectrogram: false });
    expect(l.calls).toEqual([{ model: "listen", inputs: { wav: join(ws, "exports", "mix.wav"), bpm: 132, key: "F minor", swing: 64, swing_unit: "8th" } }]);
  });

  it("a failing or missing sidecar never fails the analysis: ml says why", async () => {
    const l = listener(() => ({ ok: false, error: { code: "SIDECAR_UNAVAILABLE", message: "cannot start the sidecar (ENOENT)" } }));
    const r = await createGbAnalyze({ workspaceDir: ws, analyzer: new FakeAnalyzer(() => ok(fakeResult())), listener: l })({ command: "audio", path: "exports/mix.wav", spectrogram: false });
    expect(r).toMatchObject({ status: "verified", data: { ml: { unavailable: "SIDECAR_UNAVAILABLE" }, loudness: expect.any(Object) } });
    const none = await createGbAnalyze({ workspaceDir: ws, analyzer: new FakeAnalyzer(() => ok(fakeResult())) })({ command: "audio", path: "exports/mix.wav", spectrogram: false });
    expect(none).toMatchObject({ status: "verified", data: { ml: { unavailable: "NOT_CONFIGURED" } } });
  });

  it("asks the sidecar nothing when ml is not among the requested fields", async () => {
    const l = listener(() => ({ ok: true, value: heard }));
    await createGbAnalyze({ workspaceDir: ws, analyzer: new FakeAnalyzer(() => ok(fakeResult())), listener: l })({ command: "audio", path: "exports/mix.wav", spectrogram: false, fields: ["loudness"] });
    expect(l.calls).toEqual([]);
  });
});

describe("gb_analyze master (M13.2): a mastered copy in masters/", () => {
  const mastered = (req: { out: string; lufs: number; peak: number }) => ({
    path: req.out, rate: 44100, bits: 24 as const, seconds: 1, target: { lufs: req.lufs, true_peak_db: req.peak },
    before: { lufs: -20.1, true_peak_db: -3 }, after: { lufs: req.lufs, true_peak_db: req.peak - 0.1 }, gain_db: 6.1,
    limiter_max_reduction_db: 1.5, warnings: [] as string[],
  });
  const masterPort = () => {
    const calls: { path: string; out: string; lufs: number; peak: number }[] = [];
    const port: AnalyzerPort = {
      analyze: async () => ok(fakeResult()),
      master: async (req) => { calls.push(req); writeFileSync(req.out, bareWav(44100, 2, 44100, 24)); return { ok: true as const, value: mastered(req) }; },
    };
    return { port, calls };
  };

  it("writes masters/<filename> with the targets, checks the WAV and reports before/after", async () => {
    const { port, calls } = masterPort();
    const r = await createGbAnalyze({ workspaceDir: ws, analyzer: port })({ command: "master", path: "exports/mix.wav", filename: "mix-master.wav", lufs: -16 });
    expect(r).toMatchObject({ status: "verified", data: { path: join(ws, "masters", "mix-master.wav"), bits: 24, after: { lufs: -16 }, limiter_max_reduction_db: 1.5 } });
    expect(calls).toEqual([{ path: join(ws, "exports", "mix.wav"), out: join(ws, "masters", "mix-master.wav"), lufs: -16, peak: -1 }]);
  });

  it("never overwrites: a taken name is FILE_EXISTS before anything runs", async () => {
    const { port, calls } = masterPort();
    mkdirSync(join(ws, "masters"));
    writeFileSync(join(ws, "masters", "mix-master.wav"), "x");
    const r = await createGbAnalyze({ workspaceDir: ws, analyzer: port })({ command: "master", path: "exports/mix.wav", filename: "mix-master.wav" });
    expect(r).toMatchObject({ status: "failed", error: "FILE_EXISTS" });
    expect(calls).toHaveLength(0);
  });
});

describe("gb_analyze takes (M13.3): 2–8 takes side by side", () => {
  it("one row per take, in the order given: length, loudness, true peak, tempo, key, flags", async () => {
    const analyzer = new FakeAnalyzer((req) => ok(req.path.endsWith("mix-v2.wav") ? fakeResult(["true_peak_over"], -12) : fakeResult([], -14)));
    const r = await createGbAnalyze({ workspaceDir: ws, analyzer })({ command: "takes", paths: ["exports/mix.wav", "exports/mix-v2.wav"] });
    expect(r).toMatchObject({ status: "verified", data: { takes: [
      { path: "exports/mix.wav", seconds: 8, lufs: -14, true_peak_db: -1, bpm: 132, key: "F minor", flags: [] },
      { path: "exports/mix-v2.wav", lufs: -12, flags: ["true_peak_over"] },
    ] } });
    expect(analyzer.requests.every((q) => q.spectrogramPath === undefined)).toBe(true);
  });

  it("refuses one take or more than eight", async () => {
    const analyzer = new FakeAnalyzer(() => ok(fakeResult()));
    expect(await createGbAnalyze({ workspaceDir: ws, analyzer })({ command: "takes", paths: ["exports/mix.wav"] })).toMatchObject({ status: "failed", error: "INPUT_INVALID" });
    expect(analyzer.requests).toHaveLength(0);
  });
});

describe("gb_analyze map (M13.6): the bar structure of a recording", () => {
  const summary = { bpm: 79, steady: true, place: { guide_bpm: 79, bar: 1, beat: 1.36, offset_s: 0.27 }, chords: "D | G", voice: "####....", gaps: [], irregular: [] };
  const sidecar = () => {
    const calls: { model: string; inputs: Record<string, unknown> }[] = [];
    const port: ModelSidecar = {
      run: async (model, inputs) => {
        calls.push({ model, inputs });
        if (model === "stems") for (const s of ["vocals", "drums", "bass", "other"]) writeFileSync(join(ws, "stems", `mix-${s}.wav`), "RIFF");
        if (model === "map") writeFileSync(inputs.out as string, "{}");
        return { ok: true as const, value: model === "map" ? { map: inputs.out, ...summary } : {} };
      },
      close() {},
    };
    return { port, calls };
  };

  it("separates the stems first when they are missing, then maps; the full map goes to analysis/<name>-map.json", async () => {
    const { port, calls } = sidecar();
    mkdirSync(join(ws, "stems"));
    const r = await createGbAnalyze({ workspaceDir: ws, analyzer: new FakeAnalyzer(() => ok(fakeResult())), listener: port })({ command: "map", path: "exports/mix.wav" });
    expect(calls.map((c) => c.model)).toEqual(["stems", "map"]);
    expect(calls[1]!.inputs).toMatchObject({ wav: join(ws, "exports", "mix.wav"), stems: { vocals: join(ws, "stems", "mix-vocals.wav"), bass: join(ws, "stems", "mix-bass.wav"), other: join(ws, "stems", "mix-other.wav") }, out: join(ws, "analysis", "mix-map.json") });
    expect(r).toMatchObject({ status: "verified", data: { map: join(ws, "analysis", "mix-map.json"), bpm: 79, place: { beat: 1.36 } } });
  });

  it("uses stems that exist, and never overwrites a map (the next is -2)", async () => {
    const { port, calls } = sidecar();
    mkdirSync(join(ws, "stems"));
    for (const s of ["vocals", "drums", "bass", "other"]) writeFileSync(join(ws, "stems", `mix-${s}.wav`), "RIFF");
    mkdirSync(join(ws, "analysis"));
    writeFileSync(join(ws, "analysis", "mix-map.json"), "{}");
    await createGbAnalyze({ workspaceDir: ws, analyzer: new FakeAnalyzer(() => ok(fakeResult())), listener: port })({ command: "map", path: "exports/mix.wav" });
    expect(calls.map((c) => [c.model, c.inputs.out])).toEqual([["map", join(ws, "analysis", "mix-map-2.json")]]);
  });

  it("names the four stems it mapped (M13.14: gb_song transcribe reads them)", async () => {
    const { port } = sidecar();
    mkdirSync(join(ws, "stems"));
    const r = await createGbAnalyze({ workspaceDir: ws, analyzer: new FakeAnalyzer(() => ok(fakeResult())), listener: port })({ command: "map", path: "exports/mix.wav" });
    expect(r).toMatchObject({ status: "verified", data: { stems: Object.fromEntries(["vocals", "drums", "bass", "other"].map((s) => [s, join(ws, "stems", `mix-${s}.wav`)])) } });
  });
});

describe("gb_analyze map with sections (M13.13): all-in-one when its engine is installed", () => {
  const found = [{ start_s: 0.12, end_s: 24.78, label: "intro" }, { start_s: 24.78, end_s: 50.6, label: "verse" }];
  const ports = (sectionsAnswer: () => { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }) => {
    const calls: { model: string; inputs: Record<string, unknown> }[] = [];
    const listener: ModelSidecar = {
      run: async (model, inputs) => {
        calls.push({ model, inputs });
        if (model === "map") writeFileSync(inputs.out as string, "{}");
        return { ok: true as const, value: model === "map" ? { map: inputs.out, bpm: 79 } : {} };
      },
      close() {},
    };
    const sections: ModelSidecar = { run: async (model, inputs) => { calls.push({ model, inputs }); return sectionsAnswer() as never; }, close() {} };
    mkdirSync(join(ws, "stems"));
    for (const s of ["vocals", "drums", "bass", "other"]) writeFileSync(join(ws, "stems", `mix-${s}.wav`), "RIFF");
    return { listener, sections, calls };
  };
  const analyze = (deps: { listener: ModelSidecar; sections?: ModelSidecar }) =>
    createGbAnalyze({ workspaceDir: ws, analyzer: new FakeAnalyzer(() => ok(fakeResult())), ...deps })({ command: "map", path: "exports/mix.wav" });

  it("finds the sections on the four stems, then the map places them on GarageBand bars", async () => {
    const { listener, sections, calls } = ports(() => ({ ok: true, value: { sections: found, model: "all-in-one" } }));
    const r = await analyze({ listener, sections });
    expect(calls.map((c) => c.model)).toEqual(["sections", "map"]);
    expect(calls[0]!.inputs).toMatchObject({ wav: join(ws, "exports", "mix.wav"), stems: { drums: join(ws, "stems", "mix-drums.wav"), vocals: join(ws, "stems", "mix-vocals.wav") } });
    expect(calls[1]!.inputs).toMatchObject({ sections: found });
    expect(r).toMatchObject({ status: "verified" });
  });

  it("a failed section search leaves the map whole, with a warning", async () => {
    const { listener, sections, calls } = ports(() => ({ ok: false, error: { code: "MODEL_FAILED", message: "RuntimeError: boom" } }));
    const r = await analyze({ listener, sections });
    expect(calls.map((c) => c.model)).toEqual(["sections", "map"]);
    expect(calls[1]!.inputs.sections).toBeUndefined();
    expect(r).toMatchObject({ status: "verified" });
    expect(JSON.stringify(r)).toContain("no sections: RuntimeError: boom");
  });

  it("without the engine the map says how to add sections", async () => {
    const { listener } = ports(() => ({ ok: true, value: {} }));
    expect(JSON.stringify(await analyze({ listener }))).toContain("install-engines.sh sections");
  });
});

describe("gb_analyze never writes outside the workspace", () => {
  const linkAnalysisOut = () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "gbmcp-outside-")));
    symlinkSync(outside, join(ws, "analysis"));
    return outside;
  };

  it("map: a linked analysis/ is refused before the sidecar runs", async () => {
    const outside = linkAnalysisOut();
    mkdirSync(join(ws, "stems"));
    for (const s of ["vocals", "drums", "bass", "other"]) writeFileSync(join(ws, "stems", `mix-${s}.wav`), "RIFF");
    const calls: string[] = [];
    const listener: ModelSidecar = { run: async (m) => { calls.push(m); return { ok: true as const, value: {} }; }, close() {} };
    const r = await createGbAnalyze({ workspaceDir: ws, analyzer: new FakeAnalyzer(() => ok(fakeResult())), listener })({ command: "map", path: "exports/mix.wav" });
    expect(r).toMatchObject({ status: "failed", error: "PATH_OUTSIDE_WORKSPACE" });
    expect(calls).toEqual([]);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("audio: no spectrogram through a linked analysis/", async () => {
    linkAnalysisOut();
    const analyzer = new FakeAnalyzer(() => ok(fakeResult()));
    const r = await createGbAnalyze({ workspaceDir: ws, analyzer })({ command: "audio", path: "exports/mix.wav" });
    expect(r).toMatchObject({ status: "failed", error: "PATH_OUTSIDE_WORKSPACE" });
    expect(analyzer.requests).toHaveLength(0);
  });
});

describe("gb_analyze lyrics (M13.11): what the voice sings against the written lyrics", () => {
  const port = () => {
    const calls: { model: string; inputs: Record<string, unknown> }[] = [];
    const listener: ModelSidecar = {
      run: async (model, inputs) => {
        calls.push({ model, inputs });
        if (model === "stems") for (const s of ["vocals", "drums", "bass", "other"]) writeFileSync(join(ws, "stems", `mix-${s}.wav`), "RIFF");
        return { ok: true as const, value: model === "lyrics" ? { lines: [], wer: 0.1, summary: { sung: 3, partial: 1, missing: 0 } } : {} };
      },
      close() {},
    };
    return { listener, calls };
  };

  it("transcribes the song's vocal stem (separating first if needed) and passes the lyrics", async () => {
    const { listener, calls } = port();
    mkdirSync(join(ws, "stems"));
    const r = await createGbAnalyze({ workspaceDir: ws, analyzer: new FakeAnalyzer(() => ok(fakeResult())), listener })(
      { command: "lyrics", path: "exports/mix.wav", lyrics: "[Verse]\nla la", language: "en" });
    expect(calls.map((c) => c.model)).toEqual(["stems", "lyrics"]);
    expect(calls[1]!.inputs).toEqual({ wav: join(ws, "stems", "mix-vocals.wav"), lyrics: "[Verse]\nla la", language: "en" });
    expect(r).toMatchObject({ status: "verified", data: { wer: 0.1, summary: { sung: 3 } } });
  });

  it("a vocal stem is used as it is", async () => {
    const { listener, calls } = port();
    mkdirSync(join(ws, "stems"));
    writeFileSync(join(ws, "stems", "take-vocals.wav"), "RIFF");
    await createGbAnalyze({ workspaceDir: ws, analyzer: new FakeAnalyzer(() => ok(fakeResult())), listener })(
      { command: "lyrics", path: "stems/take-vocals.wav", lyrics: "[Verse]\nla" });
    expect(calls.map((c) => [c.model, c.inputs.wav])).toEqual([["lyrics", join(ws, "stems", "take-vocals.wav")]]);
  });
});
