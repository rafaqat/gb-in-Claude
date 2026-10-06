// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/**
 * gb_stem (M11b): bring outside audio to a song — inspect it, align it (tempo, pitch, format) and separate it into
 * vocals / drums / bass / other — so gb_band can place it on the song's bars. The work runs in the model sidecar
 * (models/gbmodels/stems.py: Demucs, Rubber Band, stroke-slicing); gb-mcp checks every file it reports with the same
 * WAV reader gb_band uses, so "verified" means gb_band will take it.
 */
import { z } from "zod";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { recordSource } from "../workspace/stem-source.js";
import { resolveWorkspaceFile, workspaceOutputDir } from "../workspace/paths.js";
import { wavInfo } from "../band/wav.js";
import type { ModelSidecar } from "../models/sidecar.js";
import { verified, failed, type Envelope } from "./envelope.js";

const AUDIO_IN = [".wav", ".aif", ".aiff", ".flac"] as const;
const STEMS_DIR = "stems";
const STEM_NAMES = ["vocals", "drums", "bass", "other"] as const;
const TEMPO_TOLERANCE = 0.02;
const LENGTH_TOLERANCE = 0.01;
const SafeWav = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,79}\.wav$/, "a .wav file name such as tabla-132.wav (no folders)");
const Bpm = z.number().min(20).max(300);

export const GbStemInput = z.discriminatedUnion("command", [
  z.object({ command: z.literal("inspect"), path: z.string().min(1), near_bpm: Bpm.optional() }).strict(),
  z.object({
    command: z.literal("prepare"), path: z.string().min(1), filename: SafeWav, to_bpm: Bpm, from_bpm: Bpm.optional(),
    semitones: z.number().min(-12).max(12).optional(), mode: z.enum(["auto", "percussive", "tonal"]).optional(),
    rate: z.union([z.literal(44100), z.literal(48000)]).optional(), dry_run: z.boolean().optional(),
  }).strict(),
  z.object({ command: z.literal("separate"), path: z.string().min(1), model: z.enum(["htdemucs", "roformer"]).optional(), dry_run: z.boolean().optional() }).strict(),
]);
export type GbStemInput = z.infer<typeof GbStemInput>;
export const GB_STEM_COMMANDS = ["inspect", "prepare", "separate"] as const;

/** models: the model sidecar (models/.venv); optional — without it every command but a dry run is DEPENDENCY_MISSING.
 * roformer: the RoFormer engine's sidecar (scripts/install-engines.sh roformer), for separate {model: "roformer"}. */
export type GbStemDeps = { workspaceDir: string; models?: ModelSidecar; roformer?: ModelSidecar };

/** Anything at this name — a file, a folder, a link (dangling or not) — counts: never write through it. */
function occupied(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

type Placeable = { ok: true; rate: number; bits: number; frames: number } | { ok: false; message: string };
function placeable(path: string): Placeable {
  if (!existsSync(path)) return { ok: false, message: `${basename(path)} was not written` };
  const info = wavInfo(new Uint8Array(readFileSync(path)));
  return info.ok ? { ok: true, rate: info.value.rate, bits: info.value.bits, frames: info.value.frames }
    : { ok: false, message: `${basename(path)}: ${info.error.message}` };
}

export function createGbStem(deps: GbStemDeps) {
  return async function gbStem(input: unknown): Promise<Envelope> {
    const parsed = GbStemInput.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      return failed("gb_stem", "INPUT_INVALID", `${issue.path.join(".") || "command"}: ${issue.message}`, { hint: `commands: ${GB_STEM_COMMANDS.join(", ")}` });
    }
    const cmd = parsed.data;
    const op = `gb_stem.${cmd.command}`;
    const source = resolveWorkspaceFile(deps.workspaceDir, cmd.path, AUDIO_IN);
    if (!source.ok) return failed(op, source.error.code, source.error.message, { hint: "paths are relative to the workspace (gb-mcp's out/ folder)" });
    const wav = source.value;
    const dryRun = "dry_run" in cmd && cmd.dry_run === true;
    const models = deps.models;
    if (!models && !dryRun) {
      return failed(op, "DEPENDENCY_MISSING", "the model sidecar is not set up", { hint: "install the models: scripts/install.sh --with-models (needs models/.venv)" });
    }
    const call = async (inputs: Record<string, unknown>) => {
      const r = await models!.run("stems", inputs);
      return r.ok ? { ok: true as const, value: r.value as Record<string, unknown> }
        : { ok: false as const, envelope: failed(op, r.error.code === "SIDECAR_UNAVAILABLE" ? "DEPENDENCY_MISSING" : "ANALYSIS_FAILED", r.error.message) };
    };

    if (cmd.command === "inspect") {
      const r = await call({ op: "inspect", wav, ...(cmd.near_bpm ? { near_bpm: cmd.near_bpm } : {}) });
      return r.ok ? verified(op, r.value) : r.envelope;
    }

    const dir = join(deps.workspaceDir, STEMS_DIR);
    if (cmd.command === "prepare") {
      const out = join(dir, cmd.filename);
      if (occupied(out)) return failed(op, "FILE_EXISTS", `${STEMS_DIR}/${cmd.filename} already exists; nothing written`, { hint: "choose a new filename" });
      const plan = { path: out, to_bpm: cmd.to_bpm, from_bpm: cmd.from_bpm ?? "measured", semitones: cmd.semitones ?? 0, mode: cmd.mode ?? "auto", rate: cmd.rate ?? 44100 };
      if (dryRun) return verified(op, { dry_run: true, ...plan });
      const made = workspaceOutputDir(deps.workspaceDir, STEMS_DIR, true);
      if (!made.ok) return failed(op, made.error.code, made.error.message);
      const target = join(made.value, cmd.filename); // through the resolved folder, never a link out of the workspace
      const r = await call({ op: "prepare", wav, out: target, to_bpm: cmd.to_bpm, ...(cmd.from_bpm ? { from_bpm: cmd.from_bpm } : {}),
        ...(cmd.semitones ? { semitones: cmd.semitones } : {}), ...(cmd.mode ? { mode: cmd.mode } : {}), ...(cmd.rate ? { rate: cmd.rate } : {}) });
      if (!r.ok) return r.envelope;
      const file = placeable(target);
      if (!file.ok) return failed(op, "AUDIO_INVALID", `the prepared file cannot be placed: ${file.message}`);
      const expected = Number(r.value.seconds);
      const seconds = file.frames / file.rate;
      if (Math.abs(seconds - expected) > Math.max(0.05, expected * LENGTH_TOLERANCE)) {
        return failed(op, "AUDIO_INVALID", `the prepared file is ${seconds.toFixed(2)} s long; ${expected.toFixed(2)} s were expected`);
      }
      const check = await call({ op: "inspect", wav: target, near_bpm: cmd.to_bpm });
      if (!check.ok) return check.envelope;
      const measured = check.value.bpm as number | null;
      const warnings: string[] = [];
      if (measured === null) warnings.push("no clear beat to measure: the tempo of the prepared file is not checked");
      else if (Math.abs(measured / cmd.to_bpm - 1) > TEMPO_TOLERANCE) {
        warnings.push(`the prepared file measures ${measured} BPM, the song is ${cmd.to_bpm}: check from_bpm (the source tempo) — or the stem has no steady beat`);
      }
      return verified(op, { ...r.value, path: target, measured_bpm: measured, key: check.value.key, rate: file.rate, bits: file.bits, seconds: Math.round(seconds * 1000) / 1000 }, warnings);
    }

    // separate
    const base = basename(wav, extname(wav));
    const roformer = cmd.model === "roformer";
    const names = roformer ? [...STEM_NAMES, "instrumental"] : STEM_NAMES;
    const targets = Object.fromEntries(names.map((s) => [s, join(dir, `${base}-${s}.wav`)]));
    const existing = Object.values(targets).filter((p) => occupied(p)).map((p) => basename(p));
    if (existing.length) return failed(op, "FILE_EXISTS", `stems already exist: ${existing.join(", ")}; nothing written`, { hint: "rename the source or move the old stems" });
    if (dryRun) return verified(op, { dry_run: true, stems: targets, model: cmd.model ?? "htdemucs" });
    if (roformer && !deps.roformer) {
      return failed(op, "DEPENDENCY_MISSING", "the RoFormer separator is not installed", { hint: "run ./scripts/install-engines.sh roformer (0.9 GB), restart Claude Code; or use model htdemucs" });
    }
    const made = workspaceOutputDir(deps.workspaceDir, STEMS_DIR, true);
    if (!made.ok) return failed(op, made.error.code, made.error.message);
    let stems: Record<string, string>;
    let model: unknown;
    let rate: unknown;
    if (roformer) { // M13.12: RoFormer takes the vocal out (18.8 dB against Demucs' 12.7), Demucs splits the rest
      const v = await deps.roformer!.run("roformer", { wav, out_dir: made.value, base });
      if (!v.ok) return failed(op, v.error.code === "SIDECAR_UNAVAILABLE" ? "DEPENDENCY_MISSING" : "ANALYSIS_FAILED", v.error.message);
      const first = v.value as { stems: Record<string, string>; model: string };
      const rest = await call({ op: "split", wav: first.stems.instrumental, out_dir: made.value, base });
      if (!rest.ok) return rest.envelope;
      stems = { ...first.stems, ...(rest.value.stems as Record<string, string>) };
      model = `${first.model} (vocals) + ${String(rest.value.model)} (drums, bass)`;
      rate = rest.value.rate;
    } else {
      const r = await call({ op: "separate", wav, out_dir: made.value });
      if (!r.ok) return r.envelope;
      stems = r.value.stems as Record<string, string>;
      model = r.value.model;
      rate = r.value.rate;
    }
    const checked = Object.entries(stems).map(([name, path]) => ({ name, path, file: placeable(path) }));
    const bad = checked.filter((c) => !c.file.ok);
    if (bad.length) return failed(op, "AUDIO_INVALID", `stems that cannot be placed: ${bad.map((b) => (b.file as { message: string }).message).join("; ")}`);
    recordSource(made.value, base, wav); // which recording these stems are
    const frames = checked.map((c) => (c.file as { frames: number }).frames);
    const warnings = Math.max(...frames) - Math.min(...frames) > Math.max(...frames) * LENGTH_TOLERANCE ? ["the stems differ in length by more than 1 %"] : [];
    return verified(op, { stems, model, rate }, warnings);
  };
}
