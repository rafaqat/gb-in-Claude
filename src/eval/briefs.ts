// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/**
 * The frozen evaluation set (M8): eval/briefs/*.json. Each brief names a genre, its target BPM, key, meter, form and a
 * one-line description, and carries a Song JSON that the current gb-mcp renders. Later milestones are measured against
 * the baseline scores of these exact files; never edit a brief — add a new set instead.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { z } from "zod";
import { err, ok, type Result } from "../result.js";
import { parseSong, type Song } from "../song/schema.js";

export const BRIEFS_DIR = fileURLToPath(new URL("../../eval/briefs", import.meta.url));

const BriefMeta = z.object({
  id: z.string().regex(/^\d{2}-[a-z0-9-]+$/),
  genre: z.string().min(1),
  bpm: z.number().min(20).max(300),
  key: z.string().regex(/^[A-G][#b]? (major|minor)$/),
  meter: z.string().regex(/^\d\/4$/),
  form: z.string().min(1),
  description: z.string().min(1),
  song: z.unknown(),
}).strict();

export type Brief = Omit<z.infer<typeof BriefMeta>, "song"> & { file: string; song: Song };

/** Every brief in `dir`, in file order, or the first file that does not parse. */
export function loadBriefs(dir = BRIEFS_DIR): Result<Brief[], string> {
  const briefs: Brief[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const meta = BriefMeta.safeParse(JSON.parse(readFileSync(join(dir, file), "utf8")));
    if (!meta.success) return err(`${file}: ${meta.error.issues[0]!.path.join(".")}: ${meta.error.issues[0]!.message}`);
    const song = parseSong(meta.data.song);
    if (!song.ok) return err(`${file}: song.${song.error.path}: ${song.error.message}`);
    briefs.push({ ...meta.data, file, song: song.value });
  }
  return ok(briefs);
}
