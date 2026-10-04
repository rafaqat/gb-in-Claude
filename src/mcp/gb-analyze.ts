// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { z } from "zod";
import { existsSync, mkdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { parseSong } from "../song/schema.js";
import { sectionTimes } from "../song/expression.js";
import { resolveWorkspaceFile } from "../workspace/paths.js";
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
]);
export const GB_ANALYZE_COMMANDS = ["audio", "against_song", "compare"] as const;

/** listener: the M8 model sidecar (beats/grid, key, genre ranking); optional — without it `ml` says so. */
export type GbAnalyzeDeps = { workspaceDir: string; analyzer: AnalyzerPort; listener?: ModelSidecar };

function project(result: AnalysisResult & { ml?: unknown }, fields: readonly Field[]) {
  return Object.fromEntries(fields.map((f) => [f, result[f]]));
}

/** First free analysis/<stem>[-n].png; the sidecar's exclusive create is the final guard. */
function spectrogramPathFor(workspace: string, audioPath: string): string | null {
  const dir = join(workspace, "analysis");
  mkdirSync(dir, { recursive: true });
  const stem = basename(audioPath, extname(audioPath));
  for (let n = 1; n <= MAX_IMAGE_SUFFIX; n++) {
    const candidate = join(dir, n === 1 ? `${stem}.png` : `${stem}-${n}.png`);
    if (!existsSync(candidate)) return candidate;
  }
  return null;
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
    const spectrogramPath = wantImage ? spectrogramPathFor(deps.workspaceDir, audio.value) : null;
    if (wantImage && !spectrogramPath) return failed(op, "FILE_EXISTS", "too many spectrograms for this file name in analysis/");
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
