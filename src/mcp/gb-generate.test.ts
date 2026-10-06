// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect, beforeEach, vi } from "vitest";
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, realpathSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGbGenerate } from "./gb-generate.js";
import { ok, err } from "../result.js";
import type { ModelSidecar } from "../models/sidecar.js";
import { bareWav } from "../band/testing.js";

type Call = { model: string; inputs: Record<string, unknown>; finish: (how?: "ok" | "fail") => void };

/** An engine sidecar that answers only when the test says so: finish() writes the WAV the engine would. */
function fakeEngine(engine: string, seconds = 10, extra: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  let closed = 0;
  const sidecar: ModelSidecar = {
    run: (model, inputs) => new Promise((resolve) => {
      calls.push({ model, inputs, finish: (how = "ok") => {
        if (how === "fail") return resolve(err({ code: "MODEL_FAILED", message: "ValueError: 80 bars last 600 s; MuLaCover makes at most 300 s" }));
        writeFileSync(inputs.out as string, bareWav(48000 * seconds, 2, 48000, 16));
        resolve(ok({ engine, path: inputs.out, seconds, rate: 48000, ...(engine === "mulacover" ? { input_bpm: 132 } : {}), ...extra }));
      } });
    }),
    close: () => { closed++; },
  };
  return { sidecar, calls, closed: () => closed };
}

const listener: ModelSidecar = { run: async () => ok({ bpm: 115.38, key: "E minor", placeable: true }), close() {} };

/** The models sidecar's stems ops as gb_generate uses them: inspect measures `bpm` (the re-timed file: `retimedBpm`);
 * prepare writes the re-timed WAV (its length × from_bpm / to_bpm, as Rubber Band does) — or fails, or writes `seconds`. */
function stemsListener(opts: { bpm?: number | null; retimedBpm?: number | null; prepare?: "ok" | "fail"; seconds?: number } = {}) {
  const calls: Record<string, unknown>[] = [];
  const sidecar: ModelSidecar = {
    run: async (_model, inputs) => {
      calls.push(inputs);
      if (inputs.op === "inspect") {
        const retimed = String(inputs.wav).endsWith("bpm.wav");
        return ok({ bpm: retimed ? (opts.retimedBpm === undefined ? 132 : opts.retimedBpm) : (opts.bpm === undefined ? 115.38 : opts.bpm), key: "E minor", placeable: true });
      }
      if (opts.prepare === "fail") return err({ code: "MODEL_FAILED", message: "RuntimeError: Rubber Band is not installed: brew install rubberband" });
      const factor = Number(inputs.from_bpm) / Number(inputs.to_bpm);
      const seconds = opts.seconds ?? Math.round(10 * factor * 44100) / 44100;
      writeFileSync(inputs.out as string, bareWav(Math.round(seconds * 44100), 2, 44100, 24));
      return ok({ out: inputs.out, mode: inputs.mode, from_bpm: inputs.from_bpm, to_bpm: inputs.to_bpm, factor: Math.round(factor * 1e6) / 1e6,
        semitones: 0, stretched: true, measured: false, rate: 44100, bits: 24, seconds: Math.round(10 * factor * 1000) / 1000 });
    },
    close() {},
  };
  return { sidecar, calls };
}

let ws: string;
let ace: ReturnType<typeof fakeEngine>;
let mula: ReturnType<typeof fakeEngine>;
const make = (engines?: Record<string, ModelSidecar>, models: ModelSidecar = listener) =>
  createGbGenerate({ workspaceDir: ws, engines: engines ?? { ace_step: ace.sidecar, mulacover: mula.sidecar }, listener: models });
const data = (r: unknown) => (r as { data: Record<string, unknown> }).data;
const done = async (gen: ReturnType<typeof make>, job: string) => {
  await vi.waitFor(async () => expect(data(await gen({ command: "status", job })).state).not.toBe("running"));
  return data(await gen({ command: "status", job }));
};

const ACE_COVER = { command: "start", engine: "ace_step", task: "cover", src: "exports/song.wav", caption: "film song, female vocals", filename: "cover.wav" };
const MULA = { command: "start", engine: "mulacover", task: "cover", midi: "song.mid", melody: ["Bansuri"], chords: ["Pad"], lyrics: "[Verse]\nla la",
  tags: "genre:[film]", filename: "vocals.wav" };

beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), "gbgen-")));
  mkdirSync(join(ws, "exports"));
  writeFileSync(join(ws, "exports", "song.wav"), bareWav(48000, 2, 48000, 16));
  writeFileSync(join(ws, "song.mid"), "MThd");
  ace = fakeEngine("ace_step");
  mula = fakeEngine("mulacover");
});

describe("gb_generate start: checks before anything runs", () => {
  it("dry_run plans (engine, task, output, an estimate) and calls nothing", async () => {
    const r = await make()({ ...ACE_COVER, dry_run: true });
    expect(r).toMatchObject({ status: "verified", data: { dry_run: true, engine: "ace_step", task: "cover", out: join(ws, "gen", "cover.wav") } });
    expect(data(r).eta_s).toBeGreaterThan(0);
    expect(ace.calls).toHaveLength(0);
  });

  it("an engine that is not installed is DEPENDENCY_MISSING with a hint", async () => {
    const r = await make({ ace_step: ace.sidecar })(MULA);
    expect(r).toMatchObject({ status: "failed", error: "DEPENDENCY_MISSING" });
    expect((r as { hint: string }).hint).toMatch(/knowledge\/generate/);
  });

  it("names a missing required input per engine", async () => {
    const r = await make()({ ...MULA, melody: undefined });
    expect(r).toMatchObject({ status: "failed", error: "INPUT_INVALID" });
    expect((r as { message: string }).message).toMatch(/melody/);
    expect(await make()({ ...ACE_COVER, task: "text" })).toMatchObject({ status: "failed", error: "INPUT_INVALID" }); // text needs duration
  });

  it("a missing source is FILE_NOT_FOUND; an output that exists is FILE_EXISTS", async () => {
    expect(await make()({ ...ACE_COVER, src: "exports/none.wav" })).toMatchObject({ status: "failed", error: "FILE_NOT_FOUND" });
    mkdirSync(join(ws, "gen"));
    writeFileSync(join(ws, "gen", "cover.wav"), "x");
    expect(await make()(ACE_COVER)).toMatchObject({ status: "failed", error: "FILE_EXISTS" });
  });
});

describe("gb_generate examples: ACE-Step's own examples as many-shot prompts for a request", () => {
  const examplesDir = () => {
    const d = join(ws, "ace-examples");
    mkdirSync(d);
    writeFileSync(join(d, "example_1.json"), JSON.stringify({ caption: "A nostalgic synthwave track for a night drive.", lyrics: "[Verse 1]\nNeon lights", bpm: 110, duration: 120, keyscale: "A minor", language: "en", timesignature: "4" }));
    writeFileSync(join(d, "example_2.json"), JSON.stringify({ caption: "A tender piano ballad with a soft female vocal.", lyrics: "[Verse 1]\nStay", bpm: 72, duration: 150, keyscale: "C major", language: "en", timesignature: "4" }));
    return d;
  };

  it("returns the best-fitting examples with caption, lyrics and metadata, and the attribution", async () => {
    const gen = createGbGenerate({ workspaceDir: ws, engines: {}, aceExamplesDir: examplesDir() });
    const r = await gen({ command: "examples", query: "synthwave for a night drive", limit: 1 });
    expect(r).toMatchObject({ status: "verified", data: { examples: [{ id: "example_1", caption: expect.stringContaining("synthwave"), lyrics: expect.any(String), bpm: 110, keyscale: "A minor", language: "en" }] } });
    expect(data(r).attribution).toMatch(/ACE-Step 1\.5.*MIT/);
  });

  it("without ACE-Step installed it is DEPENDENCY_MISSING with the install hint", async () => {
    const r = await createGbGenerate({ workspaceDir: ws, engines: {}, aceExamplesDir: join(ws, "none") })({ command: "examples", query: "pop" });
    expect(r).toMatchObject({ status: "failed", error: "DEPENDENCY_MISSING" });
    expect((r as { hint: string }).hint).toMatch(/install-engines/);
  });
});

describe("gb_generate never writes outside the workspace", () => {
  it("a MuLaCover job whose inputs folder name is taken (here a link out of the workspace) is FILE_EXISTS before it runs", async () => {
    mkdirSync(join(ws, "gen"));
    symlinkSync(mkdtempSync(join(tmpdir(), "outside-")), join(ws, "gen", "vocals-inputs"));
    const r = await make()(MULA);
    expect(r).toMatchObject({ status: "failed", error: "FILE_EXISTS" });
    expect((r as { message: string }).message).toContain("vocals-inputs");
    expect(mula.calls).toHaveLength(0);
  });
});

describe("gb_generate jobs: start returns at once, status follows the job", () => {
  it("running → done: the WAV is checked and its tempo and key measured", async () => {
    const gen = make();
    const r = await gen(ACE_COVER);
    expect(r).toMatchObject({ status: "verified", data: { state: "running", engine: "ace_step" } });
    const job = data(r).job as string;
    expect(data(await gen({ command: "status", job })).state).toBe("running");
    expect(ace.calls[0]).toMatchObject({ model: "ace_step", inputs: { task: "cover", src: join(ws, "exports", "song.wav"), out: join(ws, "gen", "cover.wav") } });
    ace.calls[0]!.finish();
    const d = await done(gen, job);
    expect(d).toMatchObject({ state: "done", result: { path: join(ws, "gen", "cover.wav"), seconds: 10, rate: 48000, bits: 16, bpm: 115.38, key: "E minor" } });
  });

  it("a MuLaCover result at another tempo than the song, with retime: false, says how to re-time it", async () => {
    const stems = stemsListener();
    const gen = make(undefined, stems.sidecar);
    const job = data(await gen({ ...MULA, retime: false })).job as string;
    mula.calls[0]!.finish();
    const r = await gen({ command: "status", job });
    await done(gen, job);
    const final = await gen({ command: "status", job });
    expect((final as { warnings?: string[] }).warnings?.join(" ")).toMatch(/gb_stem prepare .*to_bpm.*132.*from_bpm.*115\.38/);
    expect(data(final).result).not.toHaveProperty("retimed");
    expect(stems.calls.filter((c) => c.op === "prepare")).toHaveLength(0);
    expect(r.status).toBe("verified");
  });

  it("a model failure ends the job as failed, with the engine's message", async () => {
    const gen = make();
    const job = data(await gen(MULA)).job as string;
    mula.calls[0]!.finish("fail");
    expect(await done(gen, job)).toMatchObject({ state: "failed", error: { code: "MODEL_FAILED", message: expect.stringMatching(/300 s/) } });
  });

  it("one generation at a time: a second start is ENGINE_BUSY, naming the running job", async () => {
    const gen = make();
    const job = data(await gen(ACE_COVER)).job as string;
    const r = await gen({ ...MULA });
    expect(r).toMatchObject({ status: "failed", error: "ENGINE_BUSY" });
    expect((r as { message: string }).message).toContain(job);
  });

  it("starting one engine closes the other (each needs ~14 GB)", async () => {
    const gen = make();
    const job = data(await gen(ACE_COVER)).job as string;
    ace.calls[0]!.finish();
    await done(gen, job);
    await gen(MULA);
    expect(ace.closed()).toBe(1);
  });
});

describe("gb_generate re-times a MuLaCover result to the song (M13.15)", () => {
  const original = () => join(ws, "gen", "vocals.wav");
  const retimed = () => join(ws, "gen", "vocals-132bpm.wav");

  it("a result at another tempo is re-timed into a new file next to it; the original stays", async () => {
    const stems = stemsListener();
    const gen = make(undefined, stems.sidecar);
    const job = data(await gen(MULA)).job as string;
    mula.calls[0]!.finish();
    const before = readFileSync(original());
    const d = await done(gen, job);
    expect(stems.calls.find((c) => c.op === "prepare")).toEqual({ op: "prepare", wav: original(), out: retimed(), to_bpm: 132, from_bpm: 115.38, mode: "tonal" });
    expect(d).toMatchObject({ state: "done", result: { path: original(), bpm: 115.38,
      retimed: { path: retimed(), bpm: 132, from_bpm: 115.38, to_bpm: 132, rate: 44100, bits: 24, seconds: 8.741 } } });
    expect(readFileSync(original()).equals(before)).toBe(true);
    const final = await gen({ command: "status", job });
    expect((final as { warnings?: string[] }).warnings ?? []).not.toContainEqual(expect.stringMatching(/gb_stem prepare/));
  });

  it("a re-time that fails keeps the job done with the original, a warning with the reason and the manual call", async () => {
    const gen = make(undefined, stemsListener({ prepare: "fail" }).sidecar);
    const job = data(await gen(MULA)).job as string;
    mula.calls[0]!.finish();
    const d = await done(gen, job);
    expect(d).toMatchObject({ state: "done", result: { path: original(), bpm: 115.38 } });
    expect(d.result).not.toHaveProperty("retimed");
    const warnings = ((await gen({ command: "status", job })) as { warnings?: string[] }).warnings?.join(" ");
    expect(warnings).toMatch(/not re-timed: .*Rubber Band is not installed/);
    expect(warnings).toMatch(/gb_stem prepare .*to_bpm: 132, from_bpm: 115\.38/);
  });

  it("a taken name for the re-timed file (here a link) is refused: nothing is written through it", async () => {
    const stems = stemsListener();
    const gen = make(undefined, stems.sidecar);
    const job = data(await gen(MULA)).job as string;
    const outside = join(mkdtempSync(join(tmpdir(), "outside-")), "x.wav");
    symlinkSync(outside, retimed()); // dangling: a write through it would land outside the workspace
    mula.calls[0]!.finish();
    const d = await done(gen, job);
    expect(d).toMatchObject({ state: "done", result: { path: original() } });
    expect(d.result).not.toHaveProperty("retimed");
    expect(stems.calls.filter((c) => c.op === "prepare")).toHaveLength(0);
    expect(existsSync(outside)).toBe(false);
    expect(((await gen({ command: "status", job })) as { warnings?: string[] }).warnings?.join(" ")).toMatch(/not re-timed: gen\/vocals-132bpm\.wav already exists.*gb_stem prepare/);
  });

  it("a re-timed file of the wrong length is not given as the result: a warning says not to place it", async () => {
    const gen = make(undefined, stemsListener({ seconds: 5 }).sidecar); // 10 s × 115.38 / 132 = 8.74 s expected
    const job = data(await gen(MULA)).job as string;
    mula.calls[0]!.finish();
    const d = await done(gen, job);
    expect(d).toMatchObject({ state: "done", result: { path: original() } });
    expect(d.result).not.toHaveProperty("retimed");
    expect(((await gen({ command: "status", job })) as { warnings?: string[] }).warnings?.join(" "))
      .toMatch(/not re-timed: gen\/vocals-132bpm\.wav is 5\.00 s long; 8\.74 s were expected — do not place it.*gb_stem prepare/);
  });

  it("a sidecar that reports success but writes no file: the job stays done with the original", async () => {
    const gen = make(undefined, listener); // answers every op with a measurement and writes nothing
    const job = data(await gen(MULA)).job as string;
    mula.calls[0]!.finish();
    const d = await done(gen, job);
    expect(d).toMatchObject({ state: "done", result: { path: original(), bpm: 115.38 } });
    expect(((await gen({ command: "status", job })) as { warnings?: string[] }).warnings?.join(" ")).toMatch(/not re-timed: gen\/vocals-132bpm\.wav was not written/);
  });

  it("a re-timed file that measures off the song's tempo (or has no clear beat) is given with a warning", async () => {
    for (const [retimedBpm, warning] of [[126, /gen\/vocals-132bpm\.wav measures 126 BPM, the song 132/], [null, /no clear beat in gen\/vocals-132bpm\.wav/]] as const) {
      ws = realpathSync(mkdtempSync(join(tmpdir(), "gbgen-")));
      writeFileSync(join(ws, "song.mid"), "MThd");
      mula = fakeEngine("mulacover");
      const gen = make(undefined, stemsListener({ retimedBpm }).sidecar);
      const job = data(await gen(MULA)).job as string;
      mula.calls[0]!.finish();
      expect(await done(gen, job)).toMatchObject({ state: "done", result: { retimed: { path: retimed(), bpm: retimedBpm } } });
      expect(((await gen({ command: "status", job })) as { warnings?: string[] }).warnings?.join(" ")).toMatch(warning);
    }
  });

  it("a result with no clear beat is not re-timed, and the warning says so", async () => {
    const stems = stemsListener({ bpm: null });
    const gen = make(undefined, stems.sidecar);
    const job = data(await gen(MULA)).job as string;
    mula.calls[0]!.finish();
    expect(await done(gen, job)).toMatchObject({ state: "done", result: { path: original(), bpm: null } });
    expect(stems.calls.filter((c) => c.op === "prepare")).toHaveLength(0);
    expect(((await gen({ command: "status", job })) as { warnings?: string[] }).warnings?.join(" "))
      .toMatch(/no clear beat in the result: it is not re-timed.*gb_stem prepare .*to_bpm: 132/);
  });

  it("a result within 2 % of the song's tempo is not re-timed; retime is mulacover input only", async () => {
    const stems = stemsListener({ bpm: 131 });
    const gen = make(undefined, stems.sidecar);
    const job = data(await gen(MULA)).job as string;
    mula.calls[0]!.finish();
    const d = await done(gen, job);
    expect(d.result).not.toHaveProperty("retimed");
    expect(stems.calls.filter((c) => c.op === "prepare")).toHaveLength(0);
    expect(await make()({ ...ACE_COVER, retime: true })).toMatchObject({ status: "failed", error: "INPUT_INVALID", message: expect.stringMatching(/retime/) });
  });

  it("a result that ends before the bar range ends (MuLaCover stopped at its length limit) says how much may be missing", async () => {
    mula = fakeEngine("mulacover", 10, { bars: 5, range_seconds: 9.091 }); // 5 bars of 4/4 at 132 BPM; 10 s at 115.38 BPM = 8.74 s at 132
    const gen = make(undefined, stemsListener().sidecar);
    const job = data(await gen(MULA)).job as string;
    mula.calls[0]!.finish();
    expect(await done(gen, job)).toMatchObject({ state: "done", result: { retimed: { seconds: 8.741 } } });
    expect(((await gen({ command: "status", job })) as { warnings?: string[] }).warnings?.join(" "))
      .toMatch(/the result lasts 8\.74 s at 132 BPM; the 5 bars last 9\.09 s: about 0\.2 bars at the end may be missing/);
  });

  it("dry_run shows whether the result will be re-timed", async () => {
    expect(data(await make()({ ...MULA, dry_run: true }))).toMatchObject({ dry_run: true, retime: true });
    expect(data(await make()({ ...MULA, retime: false, dry_run: true }))).toMatchObject({ dry_run: true, retime: false });
  });
});

describe("gb_generate keeps its jobs on disk", () => {
  it("a new server reads finished jobs; a job left running by a dead one is interrupted", async () => {
    const first = make();
    const finished = data(await first(ACE_COVER)).job as string;
    ace.calls[0]!.finish();
    await done(first, finished);
    const left = data(await first({ ...MULA })).job as string; // never finishes
    const second = make();
    expect(data(await second({ command: "status", job: finished }))).toMatchObject({ state: "done", result: { bpm: 115.38 } });
    expect(data(await second({ command: "status", job: left })).state).toBe("interrupted");
    expect(readdirSync(join(ws, "gen", "jobs"))).toHaveLength(2);
    expect(data(await second({ command: "list" })).jobs).toHaveLength(2);
    expect(await second({ command: "status", job: "g-nope" })).toMatchObject({ status: "failed", error: "JOB_NOT_FOUND" });
  });
});

describe("gb_generate repaint (M13.9): regenerate one time range of a song, keep the rest", () => {
  it("needs src, caption and start; passes the range and the mode to ACE-Step", async () => {
    expect(await make()({ command: "start", engine: "ace_step", task: "repaint", src: "exports/song.wav", caption: "x", filename: "r.wav" }))
      .toMatchObject({ status: "failed", error: "INPUT_INVALID", message: expect.stringMatching(/start/) });
    const r = await make()({ command: "start", engine: "ace_step", task: "repaint", src: "exports/song.wav", caption: "a quiet bridge, voice and organ",
      lyrics: "[Bridge]\nOh, can you feel it", start: 12.5, end: 30, mode: "conservative", filename: "repainted.wav" });
    expect(r).toMatchObject({ status: "verified", data: { state: "running", task: "repaint" } });
    expect(ace.calls[0]!.inputs).toMatchObject({ task: "repaint", src: join(ws, "exports", "song.wav"), start: 12.5, end: 30, mode: "conservative" });
  });

  it("start, end and mode are ace_step input only", async () => {
    expect(await make()({ ...MULA, start: 3 })).toMatchObject({ status: "failed", error: "INPUT_INVALID", message: expect.stringMatching(/start/) });
  });
});

describe("gb_generate lego / complete (M13.10, ACE-Step base model)", () => {
  it("lego adds one named track; complete takes a list; both need src and caption", async () => {
    const r = await make()({ command: "start", engine: "ace_step", task: "lego", src: "exports/song.wav", caption: "uilleann pipes, Irish ornaments",
      track: "woodwinds", start: 30, end: 90, filename: "pipes.wav" });
    expect(r).toMatchObject({ status: "verified", data: { task: "lego" } });
    expect(ace.calls[0]!.inputs).toMatchObject({ task: "lego", track: "woodwinds", start: 30, end: 90 });
    expect(await make()({ command: "start", engine: "ace_step", task: "lego", src: "exports/song.wav", caption: "x", track: "bagpipes", filename: "x.wav" }))
      .toMatchObject({ status: "failed", error: "INPUT_INVALID" });
    expect(await make()({ command: "start", engine: "ace_step", task: "complete", src: "exports/song.wav", caption: "x", filename: "y.wav" }))
      .toMatchObject({ status: "failed", error: "INPUT_INVALID", message: expect.stringMatching(/tracks/) });
  });
});
