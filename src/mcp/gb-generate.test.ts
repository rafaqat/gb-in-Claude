// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGbGenerate } from "./gb-generate.js";
import { ok, err } from "../result.js";
import type { ModelSidecar } from "../models/sidecar.js";
import { bareWav } from "../band/testing.js";

type Call = { model: string; inputs: Record<string, unknown>; finish: (how?: "ok" | "fail") => void };

/** An engine sidecar that answers only when the test says so: finish() writes the WAV the engine would. */
function fakeEngine(engine: string, seconds = 10) {
  const calls: Call[] = [];
  let closed = 0;
  const sidecar: ModelSidecar = {
    run: (model, inputs) => new Promise((resolve) => {
      calls.push({ model, inputs, finish: (how = "ok") => {
        if (how === "fail") return resolve(err({ code: "MODEL_FAILED", message: "ValueError: 80 bars last 600 s; MuLaCover makes at most 300 s" }));
        writeFileSync(inputs.out as string, bareWav(48000 * seconds, 2, 48000, 16));
        resolve(ok({ engine, path: inputs.out, seconds, rate: 48000, ...(engine === "mulacover" ? { input_bpm: 132 } : {}) }));
      } });
    }),
    close: () => { closed++; },
  };
  return { sidecar, calls, closed: () => closed };
}

const listener: ModelSidecar = { run: async () => ok({ bpm: 115.38, key: "E minor", placeable: true }), close() {} };

let ws: string;
let ace: ReturnType<typeof fakeEngine>;
let mula: ReturnType<typeof fakeEngine>;
const make = (engines?: Record<string, ModelSidecar>) =>
  createGbGenerate({ workspaceDir: ws, engines: engines ?? { ace_step: ace.sidecar, mulacover: mula.sidecar }, listener });
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

  it("a MuLaCover result at another tempo than the song says how to re-time it", async () => {
    const gen = make();
    const job = data(await gen(MULA)).job as string;
    mula.calls[0]!.finish();
    const r = await gen({ command: "status", job });
    await done(gen, job);
    const final = await gen({ command: "status", job });
    expect((final as { warnings?: string[] }).warnings?.join(" ")).toMatch(/gb_stem prepare .*to_bpm.*132.*from_bpm.*115\.38/);
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
