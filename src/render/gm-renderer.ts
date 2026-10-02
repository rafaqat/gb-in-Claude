// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { z } from "zod";
import { execFile } from "node:child_process";
import { ok, err, type Result } from "../result.js";
import type { GmEventList } from "./gm-events.js";

export type GmRenderInfo = { path: string; seconds: number; peak: number };
export type GmRenderError = { code: "FILE_EXISTS" | "WRITE_FAILED" | "DEPENDENCY_MISSING" | "RENDER_FAILED" | "DEADLINE_EXCEEDED"; message: string };
export interface GmRendererPort {
  render(events: GmEventList, outPath: string): Promise<Result<GmRenderInfo, GmRenderError>>;
}

const Doc = z.union([
  z.object({ ok: z.literal(true), path: z.string(), seconds: z.number(), peak: z.number() }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.enum(["FILE_EXISTS", "WRITE_FAILED", "RENDER_FAILED", "INPUT_INVALID"]), message: z.string() }) }),
]);

/** Spawns native/bin/gm-render (argv only), feeds the event list on stdin, parses exactly one JSON line. */
export function createGmRenderer(opts: { binary: string; timeoutMs: number }): GmRendererPort {
  return {
    render(events, outPath) {
      return new Promise((resolve) => {
        const child = execFile(opts.binary, [outPath], { timeout: opts.timeoutMs, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 },
          (error, stdout) => {
            if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
              return resolve(err({ code: "DEPENDENCY_MISSING", message: "gm-render is not built (npm run build:native)" }));
            }
            if (error?.killed) return resolve(err({ code: "DEADLINE_EXCEEDED", message: "draft render took too long" }));
            const lines = stdout.split("\n").filter((l) => l.trim());
            let parsed: z.infer<typeof Doc> | undefined;
            try {
              const d = Doc.safeParse(JSON.parse(lines.at(-1) ?? ""));
              if (d.success && lines.length === 1) parsed = d.data;
            } catch { /* fall through */ }
            if (!parsed) return resolve(err({ code: "RENDER_FAILED", message: "renderer output did not match the contract" }));
            if (parsed.ok) return resolve(ok({ path: parsed.path, seconds: parsed.seconds, peak: parsed.peak }));
            const code = parsed.error.code === "INPUT_INVALID" ? "RENDER_FAILED" : parsed.error.code;
            return resolve(err({ code, message: parsed.error.message }));
          });
        child.stdin?.end(JSON.stringify(events));
      });
    },
  };
}
