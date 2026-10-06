// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { z } from "zod";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { parseSong } from "../song/schema.js";
import { sectionTimes } from "../song/expression.js";
import { resolveWorkspaceFile, workspaceOutputDir } from "../workspace/paths.js";
import { wavInfo } from "../band/wav.js";
import { compareAnalyses } from "../analysis/compare.js";
import type { AnalysisResult, AnalyzerError, AnalyzerPort } from "../analysis/analyzer.js";
import type { ModelSidecar } from "../models/sidecar.js";
import { verified, failed, type Envelope } from "./envelope.js";

export const AUDIO_EXTENSIONS = [".wav", ".aif", ".aiff", ".flac"] as const;
export const ANALYSIS_FIELDS = [
  "file", "loudness", "tonal_balance", "stereo_width", "rhythm", "drums", "key", "sections", "missing_sections",
  "section_contrast", "thresholds", "flags", "suggestions", "spectrogram", "ml",
] as const;
type Field = (typeof ANALYSIS_FIELDS)[number];
/** thresholds are static (gb://knowledge/analysis) — left out unless asked for. */
const DEFAULT_FIELDS = ANALYSIS_FIELDS.filter((f) => f !== "thresholds");
const MAX_IMAGE_SUFFIX = 99;

const Fields = z.array(z.enum(ANALYSIS_FIELDS)).min(1).optional();
export const GbAnalyzeInput = z.discriminatedUnion("command", [
  z.object({ command: z.literal("audio"), path: z.string(), spectrogram: z.boolean().optional(), fields: Fields }).strict(),
  z.object({ command: z.literal("against_song"), path: z.string(), song: z.unknown(), spectrogram: z.boolean().optional(), fields: Fields }).strict(),
  z.object({ command: z.literal("compare"), before: z.string(), after: z.string(), song: z.unknown().optional() }).strict(),
  z.object({
    command: z.literal("master"), path: z.string(), filename: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,79}\.wav$/, "a .wav file name such as song-master.wav (no folders)"),
    lufs: z.number().min(-30).max(-5).default(-14), peak: z.number().min(-6).max(0).default(-1), dry_run: z.boolean().optional(),
  }).strict(),
  z.object({ command: z.literal("takes"), paths: z.array(z.string()).min(2, "give 2–8 takes").max(8, "give 2–8 takes") }).strict(),
  z.object({ command: z.literal("map"), path: z.string(), key: z.string().optional(), melody: z.boolean().optional() }).strict(),
  z.object({ command: z.literal("lyrics"), path: z.string(), lyrics: z.string().min(1).max(8000), language: z.string().min(2).max(8).optional() }).strict(),
]);
export const GB_ANALYZE_COMMANDS = ["audio", "against_song", "compare", "master", "takes", "map", "lyrics"] as const;
const MAP_STEMS = ["vocals", "drums", "bass", "other"] as const;

/**
 * The first free analysis/<stem><suffix>[-n]<ext> — analysis/ made only inside the workspace (a linked analysis/
 * must not carry writes elsewhere; security review of M13.6). The sidecar's exclusive create is the final guard.
 */
function analysisPathFor(op: string, workspace: string, audioPath: string, suffix: string, ext: string): { ok: true; path: string } | { ok: false; envelope: Envelope } {
  const dir = workspaceOutputDir(workspace, "analysis", true);
  if (!dir.ok) return { ok: false, envelope: failed(op, dir.error.code, `analysis/: ${dir.error.message}`) };
  const stem = basename(audioPath, extname(audioPath));
  for (let n = 1; n <= MAX_IMAGE_SUFFIX; n++) {
    const candidate = join(dir.value, n === 1 ? `${stem}${suffix}${ext}` : `${stem}${suffix}-${n}${ext}`);
    if (!occupied(candidate)) return { ok: true, path: candidate };
  }
  return { ok: false, envelope: failed(op, "FILE_EXISTS", `too many ${ext} files for this name in analysis/`) };
}
const MASTERS_DIR = "masters";

/** Anything at this name — a file, a folder, a link — counts: never write through it. */
function occupied(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** listener: the M8 model sidecar (beats/grid, key, genre ranking); optional — without it `ml` says so.
 * sections: the all-in-one engine's sidecar (scripts/install-engines.sh sections) — the map's sections. */
export type GbAnalyzeDeps = { workspaceDir: string; analyzer: AnalyzerPort; listener?: ModelSidecar; sections?: ModelSidecar };

function project(result: AnalysisResult & { ml?: unknown }, fields: readonly Field[]) {
  return Object.fromEntries(fields.map((f) => [f, result[f]]));
}

function analyzerFailure(op: string, e: AnalyzerError): Envelope {
  const hints: Partial<Record<AnalyzerError["code"], string>> = {
    DEPENDENCY_MISSING: "run gb_system doctor to see which analysis dependency is missing",
    AUDIO_INVALID: "export from GarageBand as WAVE (Share ▸ Export Song to Disk)",
    DEADLINE_EXCEEDED: "analysis took too long; try a shorter export",
    FILE_EXISTS: "an image with that name appeared meanwhile; run again",
  };
  const code = e.code === "INPUT_INVALID" ? "ANALYSIS_FAILED" : e.code;
  return failed(op, code, e.message, { ...(hints[e.code] ? { hint: hints[e.code]! } : {}), recoverable: e.code !== "ANALYSIS_FAILED" });
}

export function createGbAnalyze(deps: GbAnalyzeDeps) {
  const resolveAudio = (op: string, path: string) => {
    const r = resolveWorkspaceFile(deps.workspaceDir, path, AUDIO_EXTENSIONS);
    return r.ok ? r : { ok: false as const, envelope: failed(op, r.error.code, r.error.message, { hint: "paths are relative to the workspace (gb-mcp's out/ folder)" }) };
  };

  /** Model listening for one recording; a missing or failing sidecar is reported in `ml`, never as a failed analysis. */
  const listen = async (wav: string, context?: Record<string, unknown>) => {
    if (!deps.listener) return { unavailable: "NOT_CONFIGURED", message: "the model sidecar is not set up (models/.venv)" };
    const inputs: Record<string, unknown> = { wav };
    if (context?.tempo) inputs.bpm = context.tempo;
    if (context?.key) inputs.key = context.key;
    if (context?.swing) { inputs.swing = context.swing; inputs.swing_unit = context.swing_unit; }
    const heard = await deps.listener.run("listen", inputs);
    return heard.ok ? heard.value : { unavailable: heard.error.code, message: heard.error.message };
  };

  return async function gbAnalyze(input: unknown): Promise<Envelope> {
    const parsed = GbAnalyzeInput.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      return failed("gb_analyze", "INPUT_INVALID", `${issue.path.join(".") || "command"}: ${issue.message}`,
        { hint: `commands: ${GB_ANALYZE_COMMANDS.join(", ")}; fields: ${ANALYSIS_FIELDS.join(", ")}` });
    }
    const cmd = parsed.data;
    const op = `gb_analyze.${cmd.command}`;

    let context: Record<string, unknown> | undefined;
    const song = cmd.command === "compare" ? cmd.song : cmd.command === "against_song" ? cmd.song : undefined;
    if (song !== undefined) {
      const s = parseSong(song);
      if (!s.ok) return failed(op, "SONG_INVALID", `${s.error.path}: ${s.error.message}`);
      context = {
        title: s.value.title, tempo: s.value.tempo, beats_per_bar: s.value.timeSignature[0], key: s.value.key ?? null,
        ...(s.value.swing ? { swing: s.value.swing, swing_unit: s.value.swingUnit } : {}),
        style: s.value.style ?? null,
        // M11: with section tempi the bar map is not uniform: pass each section's real times
        sections: s.value.sections.some((x) => x.tempo !== undefined || x.tempoTo !== undefined)
          ? ((times) => s.value.sections.map((x, i) => ({ ...x, ...times[i] })))(sectionTimes(s.value)) : s.value.sections,
        tracks: s.value.tracks.map((t) => ({ name: t.name, role: t.role, sections: Object.keys(t.parts) })),
      };
    }

    const sidecarFailure = (e: { code: string; message: string }) => failed(op, e.code === "SIDECAR_UNAVAILABLE" ? "DEPENDENCY_MISSING" : "ANALYSIS_FAILED", e.message);
    /** The recording's stems in stems/ — separated first (Demucs) when they are missing. */
    const stemsOf = async (wav: string): Promise<{ ok: true; stems: Record<(typeof MAP_STEMS)[number], string> } | { ok: false; envelope: Envelope }> => {
      const dir = workspaceOutputDir(deps.workspaceDir, "stems", true);
      if (!dir.ok) return { ok: false, envelope: failed(op, dir.error.code, dir.error.message) };
      const base = basename(wav, extname(wav));
      const stems = Object.fromEntries(MAP_STEMS.map((s) => [s, join(dir.value, `${base}-${s}.wav`)])) as Record<(typeof MAP_STEMS)[number], string>;
      if (!MAP_STEMS.every((s) => existsSync(stems[s]))) {
        const sep = await deps.listener!.run("stems", { op: "separate", wav, out_dir: dir.value });
        if (!sep.ok) return { ok: false, envelope: sidecarFailure(sep.error) };
        if (!MAP_STEMS.every((s) => existsSync(stems[s]))) return { ok: false, envelope: failed(op, "ANALYSIS_FAILED", "the separation wrote no stems") };
      }
      return { ok: true, stems };
    };

    if (cmd.command === "lyrics") {
      const audio = resolveAudio(op, cmd.path);
      if (!audio.ok) return audio.envelope;
      if (!deps.listener) return failed(op, "DEPENDENCY_MISSING", "the model sidecar is not set up (models/.venv)", { hint: "install the models: scripts/install.sh --with-models" });
      let voice = audio.value;
      if (!basename(voice).toLowerCase().endsWith("-vocals.wav")) { // a mix: transcribe its vocal stem
        const st = await stemsOf(audio.value);
        if (!st.ok) return st.envelope;
        voice = st.stems.vocals;
      }
      const r = await deps.listener.run("lyrics", { wav: voice, lyrics: cmd.lyrics, ...(cmd.language ? { language: cmd.language } : {}) });
      if (!r.ok) return sidecarFailure(r.error);
      return verified(op, r.value);
    }

    if (cmd.command === "map") {
      const audio = resolveAudio(op, cmd.path);
      if (!audio.ok) return audio.envelope;
      if (!deps.listener) return failed(op, "DEPENDENCY_MISSING", "the model sidecar is not set up (models/.venv)", { hint: "install the models: scripts/install.sh --with-models" });
      const st = await stemsOf(audio.value);
      if (!st.ok) return st.envelope;
      const stems = st.stems;
      const mapPath = analysisPathFor(op, deps.workspaceDir, audio.value, "-map", ".json");
      if (!mapPath.ok) return mapPath.envelope;
      const out = mapPath.path;
      const warnings: string[] = [];
      let sections: unknown;
      if (!deps.sections) warnings.push("no sections: the section engine is not installed (./scripts/install-engines.sh sections, then restart)");
      else { // M13.13: all-in-one on the same stems (it would separate them again itself)
        const found = await deps.sections.run("sections", { wav: audio.value, stems });
        if (found.ok) sections = (found.value as { sections?: unknown }).sections;
        else warnings.push(`no sections: ${found.error.message}`);
      }
      const r = await deps.listener.run("map", { wav: audio.value, stems, out, ...(cmd.key ? { key: cmd.key } : {}), ...(cmd.melody === false ? { melody: false } : {}),
        ...(sections !== undefined ? { sections } : {}) });
      if (!r.ok) return sidecarFailure(r.error);
      if (!existsSync(out)) return failed(op, "ANALYSIS_FAILED", "the map file was not written");
      return verified(op, { ...(r.value as object), stems }, warnings.length ? warnings : undefined);
    }

    if (cmd.command === "takes") {
      const resolved = [];
      for (const p of cmd.paths) {
        const a = resolveAudio(op, p);
        if (!a.ok) return a.envelope;
        resolved.push({ given: p, path: a.value });
      }
      const takes = [];
      for (const t of resolved) { // one analysis at a time (CPU); the model listener runs beside it
        const [r, ml] = await Promise.all([deps.analyzer.analyze({ path: t.path }), deps.listener ? listen(t.path) : Promise.resolve(undefined)]);
        if (!r.ok) return analyzerFailure(op, r.error);
        const heard = ml as { beats?: { bpm?: number | null }; key?: { key?: string } } | undefined;
        takes.push({
          path: t.given, seconds: r.value.file.seconds, lufs: r.value.loudness.integrated_lufs, true_peak_db: r.value.loudness.levels.true_peak_dbtp,
          bpm: heard?.beats?.bpm ?? r.value.rhythm.tempo.bpm, key: heard?.key?.key ?? r.value.key.estimated,
          measured_by: heard?.beats?.bpm ? "beat_this + S-KEY" : "librosa", flags: r.value.flags,
        });
      }
      return verified(op, { takes });
    }

    if (cmd.command === "master") {
      const source = resolveAudio(op, cmd.path);
      if (!source.ok) return source.envelope;
      const dir = workspaceOutputDir(deps.workspaceDir, MASTERS_DIR, !cmd.dry_run);
      if (!dir.ok) return failed(op, dir.error.code, dir.error.message);
      const out = join(dir.value, cmd.filename);
      if (occupied(out)) return failed(op, "FILE_EXISTS", `${MASTERS_DIR}/${cmd.filename} already exists; nothing written`, { hint: "choose a new filename (e.g. add -v2)" });
      if (cmd.dry_run) return verified(op, { dry_run: true, path: out, target: { lufs: cmd.lufs, true_peak_db: cmd.peak }, plan: ["gain to the loudness target", "true-peak limiter under the ceiling", "write 24-bit, read back and measure"] });
      if (!deps.analyzer.master) return failed(op, "DEPENDENCY_MISSING", "this analyzer cannot master", { hint: "run gb_system doctor" });
      const r = await deps.analyzer.master({ path: source.value, out, lufs: cmd.lufs, peak: cmd.peak });
      if (!r.ok) return analyzerFailure(op, r.error);
      const info = existsSync(out) ? wavInfo(new Uint8Array(readFileSync(out))) : null;
      if (!info || !info.ok || info.value.bits !== 24) return failed(op, "ANALYSIS_FAILED", `${cmd.filename} was not written as a 24-bit WAV`);
      const { warnings, ...data } = r.value;
      return verified(op, { ...data, path: out }, warnings);
    }

    if (cmd.command === "compare") {
      const before = resolveAudio(op, cmd.before);
      if (!before.ok) return before.envelope;
      const after = resolveAudio(op, cmd.after);
      if (!after.ok) return after.envelope;
      const a = await deps.analyzer.analyze({ path: before.value, ...(context ? { context } : {}) });
      if (!a.ok) return analyzerFailure(op, a.error);
      const b = await deps.analyzer.analyze({ path: after.value, ...(context ? { context } : {}) });
      if (!b.ok) return analyzerFailure(op, b.error);
      const summary = (r: AnalysisResult) => ({ integrated_lufs: r.loudness.integrated_lufs, flags: r.flags, centroid_hz: r.tonal_balance.centroid_hz });
      return verified(op, { ...compareAnalyses(a.value, b.value), before: summary(a.value), after: summary(b.value) });
    }

    const audio = resolveAudio(op, cmd.path);
    if (!audio.ok) return audio.envelope;
    const wantImage = cmd.spectrogram ?? true;
    let spectrogramPath: string | null = null;
    if (wantImage) {
      const image = analysisPathFor(op, deps.workspaceDir, audio.value, "", ".png");
      if (!image.ok) return image.envelope;
      spectrogramPath = image.path;
    }
    const fields = cmd.fields ?? DEFAULT_FIELDS;
    // librosa (CPU, its own process) and the model sidecar (mostly Metal) run side by side
    const [r, ml] = await Promise.all([
      deps.analyzer.analyze({ path: audio.value, ...(context ? { context } : {}), ...(spectrogramPath ? { spectrogramPath } : {}) }),
      fields.includes("ml") ? listen(audio.value, context) : Promise.resolve(undefined),
    ]);
    if (!r.ok) return analyzerFailure(op, r.error);
    return verified(op, project({ ...r.value, ml }, fields));
  };
}
