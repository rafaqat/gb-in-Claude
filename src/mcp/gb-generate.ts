// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/**
 * gb_generate (M12b): music and vocals from the M12 engines, as background jobs.
 * - ace_step (ACE-Step 1.5, MIT): `cover` re-sings / re-plays a song export to a caption and lyrics (strength = how
 *   closely it keeps the source); `text` makes music from a caption, bpm, key and length.
 * - mulacover (MuLaCover; weights AND outputs non-commercial): `cover` sings lyrics on a song's own melody, chords and
 *   drums, read from its MIDI; it chooses its own tempo, so the result says how to re-time it (gb_stem prepare).
 * A generation takes 1.5–8 minutes on an M4 Air — longer than many MCP clients wait for one call — so `start` returns a
 * job at once and `status` follows it; every job is also kept in gen/jobs/<job>.json. One generation runs at a time,
 * and starting one engine closes the other's sidecar (each needs ~14 GB). A finished WAV is checked with gb_band's WAV
 * reader and its tempo and key are measured, so the next steps are gb_stem separate / prepare and gb_band build.
 */
import { z } from "zod";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { randomBytes } from "node:crypto";
import { resolveWorkspaceFile, workspaceOutputDir } from "../workspace/paths.js";
import { wavInfo } from "../band/wav.js";
import type { ModelSidecar } from "../models/sidecar.js";
import { verified, failed, type Envelope } from "./envelope.js";

export const ENGINES = ["ace_step", "mulacover"] as const;
type Engine = (typeof ENGINES)[number];
const GEN_DIR = "gen";
const JOBS_DIR = "gen/jobs";
const AUDIO_IN = [".wav", ".aif", ".aiff", ".flac"] as const;
const TEMPO_TOLERANCE = 0.02;
const GUIDE = "read gb://knowledge/generate (engines, install, times, licences)";

const SafeWav = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,79}\.wav$/, "a .wav file name such as vocals-v1.wav (no folders)");
const Names = z.array(z.string().min(1).max(64)).min(1).max(8);

const Start = z.object({
  command: z.literal("start"),
  engine: z.enum(ENGINES),
  task: z.enum(["cover", "text"]),
  filename: SafeWav,
  // ace_step
  src: z.string().min(1).optional(),
  caption: z.string().min(1).max(512).optional(),
  strength: z.number().min(0).max(1).optional(),
  bpm: z.number().int().min(30).max(300).optional(),
  key: z.string().min(1).max(32).optional(),
  duration: z.number().min(10).max(600).optional(),
  thinking: z.boolean().optional(),
  // mulacover
  midi: z.string().min(1).optional(),
  melody: Names.optional(),
  chords: Names.optional(),
  drums: Names.optional(),
  start_bar: z.number().int().min(1).optional(),
  bars: z.number().int().min(1).max(200).optional(),
  tags: z.string().min(1).max(512).optional(),
  // both
  lyrics: z.string().min(1).max(4096).optional(),
  seed: z.number().int().min(0).max(2 ** 31 - 1).optional(),
  dry_run: z.boolean().optional(),
}).strict();
type StartInput = z.infer<typeof Start>;

export const GbGenerateInput = z.discriminatedUnion("command", [
  Start,
  z.object({ command: z.literal("status"), job: z.string().regex(/^g-[a-z0-9-]{1,64}$/, "a job id from start, such as g-20261005-120000-ab12") }).strict(),
  z.object({ command: z.literal("list") }).strict(),
]);
export const GB_GENERATE_COMMANDS = ["start", "status", "list"] as const;

const REQUIRED: Record<string, readonly (keyof StartInput)[]> = {
  "ace_step:cover": ["src", "caption"],
  "ace_step:text": ["caption", "duration"],
  "mulacover:cover": ["midi", "melody", "chords", "lyrics", "tags"],
};
const ONLY: Record<Engine, readonly (keyof StartInput)[]> = {
  ace_step: ["src", "caption", "strength", "bpm", "key", "duration", "thinking"],
  mulacover: ["midi", "melody", "chords", "drums", "start_bar", "bars", "tags"],
};

export type JobState = "running" | "done" | "failed" | "interrupted";
type Job = {
  job: string; engine: Engine; task: string; state: JobState; out: string; started_at: string; finished_at?: string;
  eta_s: number; result?: Record<string, unknown>; error?: { code: string; message: string }; warnings?: string[];
};

/** engines: one sidecar per installed engine (missing = not installed); listener: the models/.venv sidecar (measures). */
export type GbGenerateDeps = { workspaceDir: string; engines: Partial<Record<Engine, ModelSidecar>>; listener?: ModelSidecar };

function occupied(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
const seconds = (from: string, to?: string) => Math.round(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000);

/** Rough estimates from the M12a / M12d measurements on an M4 Air (load included). */
function estimate(input: StartInput, srcSeconds: number | null): number {
  if (input.engine === "ace_step" && input.task === "text") return Math.round(35 + (input.thinking === false ? 1.0 : 2.4) * (input.duration ?? 30));
  if (input.engine === "ace_step") return Math.round(35 + 1.0 * (srcSeconds ?? 120));
  const sec = (input.bars ?? 32) * 1.9; // ≈ 4 beats at 126 BPM per bar
  return Math.round(20 + 1.9 * sec + 60 * Math.ceil(sec / 25.6));
}

export function createGbGenerate(deps: GbGenerateDeps) {
  const jobs = new Map<string, Job>(); // the jobs this server started
  let running: string | null = null;
  const jobPath = (dir: string, job: string) => join(dir, `${job}.json`);

  const save = (dir: string, job: Job) => {
    const tmp = `${jobPath(dir, job.job)}.tmp`;
    writeFileSync(tmp, JSON.stringify(job, null, 1));
    renameSync(tmp, jobPath(dir, job.job));
  };
  const read = (job: string): Job | null => {
    const mine = jobs.get(job);
    if (mine) return mine;
    const path = join(deps.workspaceDir, JOBS_DIR, `${job}.json`);
    if (!existsSync(path)) return null;
    const stored = JSON.parse(readFileSync(path, "utf8")) as Job;
    return stored.state === "running" ? { ...stored, state: "interrupted" } : stored; // its server is gone
  };
  const summary = (j: Job) => ({
    job: j.job, engine: j.engine, task: j.task, state: j.state, out: j.out, started_at: j.started_at,
    elapsed_s: seconds(j.started_at, j.finished_at), eta_s: j.eta_s,
    ...(j.result ? { result: j.result } : {}), ...(j.error ? { error: j.error } : {}),
  });

  async function finish(job: Job, dir: string, engine: ModelSidecar, inputs: Record<string, unknown>, songBpm: number | null) {
    const r = await engine.run(job.engine, inputs);
    const end = (state: JobState, extra: Partial<Job>) => {
      Object.assign(job, { state, finished_at: new Date().toISOString(), ...extra });
      save(dir, job);
      running = null;
    };
    if (!r.ok) return end("failed", { error: { code: r.error.code, message: r.error.message } });
    if (!existsSync(job.out)) return end("failed", { error: { code: "AUDIO_INVALID", message: "the engine reported success but wrote no file" } });
    const info = wavInfo(new Uint8Array(readFileSync(job.out)));
    if (!info.ok) return end("failed", { error: { code: "AUDIO_INVALID", message: info.error.message } });
    const value = r.value as Record<string, unknown>;
    const inputBpm = typeof value.input_bpm === "number" ? value.input_bpm : songBpm;
    const warnings: string[] = [];
    let measured: { bpm?: number | null; key?: string | null } = {};
    if (deps.listener) {
      const m = await deps.listener.run("stems", { op: "inspect", wav: job.out, ...(inputBpm ? { near_bpm: inputBpm } : {}) });
      if (m.ok) measured = m.value as typeof measured;
      else warnings.push(`tempo and key not measured: ${m.error.message}`);
    } else warnings.push("tempo and key not measured: the model sidecar is not installed");
    const rel = relative(deps.workspaceDir, job.out);
    if (inputBpm && typeof measured.bpm === "number" && Math.abs(measured.bpm / inputBpm - 1) > TEMPO_TOLERANCE) {
      warnings.push(`the result runs at ${measured.bpm} BPM, the song at ${inputBpm}: re-time it before placing — gb_stem prepare ` +
        `{path: "${rel}", filename: "…", to_bpm: ${inputBpm}, from_bpm: ${measured.bpm}}`);
    }
    end("done", {
      result: { ...value, path: job.out, seconds: Math.round((info.value.frames / info.value.rate) * 1000) / 1000, rate: info.value.rate,
        bits: info.value.bits, bpm: measured.bpm ?? null, key: measured.key ?? null },
      ...(warnings.length ? { warnings } : {}),
    });
  }

  return async function gbGenerate(raw: unknown): Promise<Envelope> {
    const parsed = GbGenerateInput.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      return failed("gb_generate", "INPUT_INVALID", `${issue.path.join(".") || "command"}: ${issue.message}`, { hint: `commands: ${GB_GENERATE_COMMANDS.join(", ")}; ${GUIDE}` });
    }
    const cmd = parsed.data;
    const op = `gb_generate.${cmd.command}`;

    if (cmd.command === "list") {
      const dir = join(deps.workspaceDir, JOBS_DIR);
      const ids = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)) : [];
      const all = ids.map(read).filter((j): j is Job => j !== null).sort((a, b) => a.started_at.localeCompare(b.started_at));
      return verified(op, { jobs: all.map(summary) });
    }
    if (cmd.command === "status") {
      const job = read(cmd.job);
      if (!job) return failed(op, "JOB_NOT_FOUND", `no job ${cmd.job} in ${JOBS_DIR}`, { hint: "gb_generate list shows the jobs" });
      return verified(op, summary(job), job.state === "done" ? job.warnings : undefined);
    }

    // start
    const key = `${cmd.engine}:${cmd.task}`;
    const required = REQUIRED[key];
    if (!required) return failed(op, "INPUT_INVALID", `${cmd.engine} has no task ${cmd.task}; tasks: ace_step cover | text, mulacover cover`);
    const missing = required.filter((f) => cmd[f] === undefined);
    if (missing.length) return failed(op, "INPUT_INVALID", `${cmd.engine} ${cmd.task} needs ${missing.join(", ")}`, { hint: GUIDE });
    const foreign = ONLY[cmd.engine === "ace_step" ? "mulacover" : "ace_step"].filter((f) => cmd[f] !== undefined);
    if (foreign.length) return failed(op, "INPUT_INVALID", `${foreign.join(", ")} ${foreign.length > 1 ? "are" : "is"} not ${cmd.engine} input`, { hint: GUIDE });
    const engine = deps.engines[cmd.engine];
    if (!engine) return failed(op, "DEPENDENCY_MISSING", `the ${cmd.engine} engine is not installed`, { hint: GUIDE });

    const inputs: Record<string, unknown> = { task: cmd.task };
    let srcSeconds: number | null = null;
    if (cmd.engine === "ace_step") {
      if (cmd.src) {
        const src = resolveWorkspaceFile(deps.workspaceDir, cmd.src, AUDIO_IN);
        if (!src.ok) return failed(op, src.error.code, src.error.message, { hint: "paths are relative to the workspace" });
        inputs.src = src.value;
        const info = src.value.endsWith(".wav") ? wavInfo(new Uint8Array(readFileSync(src.value))) : null;
        srcSeconds = info?.ok ? info.value.frames / info.value.rate : null;
      }
      for (const f of ["caption", "lyrics", "strength", "bpm", "key", "duration", "thinking", "seed"] as const) if (cmd[f] !== undefined) inputs[f] = cmd[f];
    } else {
      const midi = resolveWorkspaceFile(deps.workspaceDir, cmd.midi!, [".mid"]);
      if (!midi.ok) return failed(op, midi.error.code, midi.error.message, { hint: "render the Song JSON first: gb_song render_midi" });
      inputs.midi = midi.value;
      for (const f of ["melody", "chords", "drums", "start_bar", "bars", "lyrics", "tags", "seed"] as const) if (cmd[f] !== undefined) inputs[f] = cmd[f];
    }
    const out = join(deps.workspaceDir, GEN_DIR, cmd.filename);
    if (occupied(out)) return failed(op, "FILE_EXISTS", `${GEN_DIR}/${cmd.filename} already exists; nothing written`, { hint: "choose a new filename" });
    // MuLaCover also writes its MIDI inputs into a new folder next to the output; the engine refuses a taken name too
    const inputsDir = `${cmd.filename.slice(0, -".wav".length)}-inputs`;
    if (cmd.engine === "mulacover" && occupied(join(deps.workspaceDir, GEN_DIR, inputsDir))) {
      return failed(op, "FILE_EXISTS", `${GEN_DIR}/${inputsDir} already exists; nothing written`, { hint: "choose a new filename" });
    }
    const eta = estimate(cmd, srcSeconds);
    if (cmd.dry_run) return verified(op, { dry_run: true, engine: cmd.engine, task: cmd.task, out, eta_s: eta, inputs: { ...inputs, out } });
    if (running) {
      return failed(op, "ENGINE_BUSY", `job ${running} is still generating; one generation runs at a time`, { hint: `poll gb_generate status {job: "${running}"}` });
    }
    const gen = workspaceOutputDir(deps.workspaceDir, GEN_DIR, true);
    if (!gen.ok) return failed(op, gen.error.code, gen.error.message);
    const dir = workspaceOutputDir(deps.workspaceDir, JOBS_DIR, true);
    if (!dir.ok) return failed(op, dir.error.code, dir.error.message);
    mkdirSync(dir.value, { recursive: true });
    const outPath = join(gen.value, cmd.filename); // through the resolved folder, never a link out of the workspace
    const job: Job = { job: `g-${stamp()}-${randomBytes(2).toString("hex")}`, engine: cmd.engine, task: cmd.task, state: "running",
      out: outPath, started_at: new Date().toISOString(), eta_s: eta };
    jobs.set(job.job, job);
    save(dir.value, job);
    running = job.job;
    for (const other of ENGINES) if (other !== cmd.engine) deps.engines[other]?.close(); // free its memory first
    void finish(job, dir.value, engine, { ...inputs, out: outPath }, cmd.bpm ?? null).catch((e: unknown) => {
      Object.assign(job, { state: "failed", finished_at: new Date().toISOString(), error: { code: "INTERNAL_ERROR", message: String(e).slice(0, 300) } });
      save(dir.value, job);
      running = null;
    });
    return verified(op, { ...summary(job), poll_after_s: Math.min(30, Math.max(10, Math.round(eta / 10))) });
  };
}
