// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { ok, err, type Result } from "../result.js";
import { cleanText } from "./text.js";

export type SampleEntry = { name: string; relPath: string; format: string; bytes: number; path: string };
export const SAMPLE_FIELDS = ["name", "relPath", "format", "bytes", "path"] as const;

const AUDIO = new Set(["wav", "aif", "aiff", "caf", "flac", "mp3", "m4a"]);
const MAX_DEPTH = 6;

/** Audio files under <workspace>/samples only. Symlinks are never followed (no escape from the workspace). */
export function listSamples(workspaceDir: string, f: { query?: string | undefined }): Result<SampleEntry[], string> {
  const root = join(workspaceDir, "samples");
  if (!existsSync(root) && !isSymlink(root)) return ok([]);
  if (isSymlink(root)) return err("samples folder is a symlink; refusing to follow it outside the workspace");
  const q = f.query?.toLowerCase();
  const found: SampleEntry[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      const dot = e.name.lastIndexOf(".");
      const format = dot > 0 ? e.name.slice(dot + 1).toLowerCase() : "";
      if (!e.isFile() || !AUDIO.has(format)) continue;
      const name = cleanText(e.name.slice(0, dot));
      if (q !== undefined && !name.toLowerCase().includes(q)) continue;
      found.push({ name, relPath: relative(root, full).split(sep).join("/"), format, bytes: statSync(full).size, path: full });
    }
  };
  walk(root, 0);
  return ok(found.sort((a, b) => a.relPath.localeCompare(b.relPath)));
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
