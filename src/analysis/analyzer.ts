// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { z } from "zod";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, err, type Result } from "../result.js";

const num = z.number().nullable();
const share = z.object({ share: num, db: num });

const SuggestionSchema = z.object({
  code: z.string(),
  severity: z.enum(["info", "warning", "error"]),
  metric: z.object({ name: z.string(), value: z.unknown(), threshold: z.unknown() }),
  path: z.string(),
  message: z.string(),
  section: z.string().optional(),
});

const SectionSchema = z.object({
  name: z.string(),
  start_s: z.number(),
  end_s: z.number(),
  truncated: z.boolean(),
  lufs: num,
  onset_density: z.number(),
  centroid_hz: num,
  tilt_db_per_octave: num,
  low_share: num,
  pump: z.object({ detected: z.boolean().nullable(), depth_db: num }),
  percussive_ratio_db: num,
  kick_hit_share: num,
  kick_band_share: num,
});

/** Mirror of gbanalyze.analyze() + the CLI's spectrogram field. Parse, don't trust. */
export const AnalysisResultSchema = z.object({
  file: z.object({ seconds: z.number(), sample_rate: z.number().int(), channels: z.number().int() }),
  loudness: z.object({
    integrated_lufs: num,
    levels: z.object({
      sample_peak_dbfs: num, true_peak_dbtp: num, rms_dbfs: num, crest_db: num,
      clipped_samples: z.number().int(), clip_runs: z.number().int(),
    }),
  }),
  tonal_balance: z.object({
    bands: z.object({ sub: share, low: share, mid: share, presence: share, air: share }),
    tilt_db_per_octave: num,
    centroid_hz: num,
  }),
  stereo_width: z.object({
    mono_source: z.boolean(),
    overall: num,
    bands: z.object({ low: num, mid: num, high: num }),
  }),
  rhythm: z.object({
    tempo: z.object({
      bpm: num, bpm_folded: num, relation_to_intended: z.string().nullable(),
      matches_intended: z.boolean().nullable(), confidence: num,
    }),
    onset_density: z.number(),
    pump: z.object({ detected: z.boolean().nullable(), depth_db: num, trough_phase: num, peak_phase: num, strength: num }),
  }),
  drums: z.object({ percussive_ratio_db: num, kick_band_share: num }),
  key: z.object({ estimated: z.string().nullable(), confidence: num, declared: z.string().nullable(), relation: z.string().nullable() }),
  sections: z.array(SectionSchema),
  missing_sections: z.array(z.string()),
  section_contrast: z.object({ loudest: z.string().nullable(), quietest: z.string().nullable(), range_lu: num, drop_minus_breakdown_lu: num }),
  thresholds: z.record(z.string(), z.number()),
  flags: z.array(z.string()),
  suggestions: z.array(SuggestionSchema),
  spectrogram: z.string().nullable(),
});
export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;

const SIDECAR_CODES = ["FILE_NOT_FOUND", "AUDIO_INVALID", "INPUT_INVALID", "FILE_EXISTS", "DEPENDENCY_MISSING", "NOT_SUPPORTED", "ANALYSIS_FAILED"] as const;
export type AnalyzerErrorCode = (typeof SIDECAR_CODES)[number] | "DEADLINE_EXCEEDED";
export type AnalyzerError = { code: AnalyzerErrorCode; message: string };

const SidecarDoc = z.union([
  z.object({ ok: z.literal(true), result: AnalysisResultSchema }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.enum(SIDECAR_CODES), message: z.string() }) }),
]);

/** The sidecar must print exactly one JSON document. Anything else is a failure, never a result. */
export function parseAnalyzerOutput(stdout: string, _exitCode: number | null): Result<AnalysisResult, AnalyzerError> {
  const lines = stdout.split("\n").filter((l) => l.trim() !== "");
  const failed = (message: string) => err({ code: "ANALYSIS_FAILED" as const, message });
  if (lines.length !== 1) return failed(lines.length === 0 ? "analyzer printed nothing" : "analyzer printed extra output");
  let json: unknown;
  try {
    json = JSON.parse(lines[0]!);
  } catch {
    return failed("analyzer output is not JSON");
  }
  const doc = SidecarDoc.safeParse(json);
  if (!doc.success) return failed(`analyzer output does not match the contract (${doc.error.issues[0]!.path.join(".")})`);
  return doc.data.ok ? ok(doc.data.result) : err(doc.data.error);
}

export type AnalyzeRequest = { path: string; context?: Record<string, unknown>; spectrogramPath?: string };
export interface AnalyzerPort {
  analyze(req: AnalyzeRequest): Promise<Result<AnalysisResult, AnalyzerError>>;
}

export type PythonAnalyzerOptions = { python: string; analysisDir: string; timeoutMs: number };

/** Runs `python3 -m gbanalyze.cli analyze …` with argv only (no shell), a deadline and an output cap. */
export function createPythonAnalyzer(opts: PythonAnalyzerOptions): AnalyzerPort {
  return {
    analyze(req) {
      const args = ["-m", "gbanalyze.cli", "analyze", "--input", req.path];
      if (req.context) args.push("--context", JSON.stringify(req.context));
      if (req.spectrogramPath) args.push("--spectrogram", req.spectrogramPath);
      const env = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? tmpdir(),
        MPLCONFIGDIR: join(tmpdir(), "gbmcp-mpl"),
        PYTHONDONTWRITEBYTECODE: "1",
      };
      return new Promise((resolve) => {
        execFile(opts.python, args, { cwd: opts.analysisDir, timeout: opts.timeoutMs, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024, env },
          (error, stdout) => {
            if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
              resolve(err({ code: "DEPENDENCY_MISSING", message: `python not found at ${opts.python}` }));
            } else if (error && error.killed) {
              resolve(err({ code: "DEADLINE_EXCEEDED", message: `analysis exceeded ${Math.round(opts.timeoutMs / 1000)} s` }));
            } else {
              resolve(parseAnalyzerOutput(stdout, error ? (error.code as number | null) ?? 1 : 0));
            }
          });
      });
    },
  };
}
