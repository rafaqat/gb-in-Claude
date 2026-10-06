// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/**
 * Which recording the stems in stems/ came from. Stems are named after the recording
 * (<name>-vocals.wav …), so gen/song.wav and exports/song.wav would share them: a record written next to the stems
 * when they are made — the recording's real path, size and modification time — decides whether they may be reused.
 */
import { lstatSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type SourceRecord = { source: string; size: number; mtime_ms: number };

const recordPath = (stemsDir: string, base: string) => join(stemsDir, `${base}.source.json`);

function fingerprint(wav: string): SourceRecord {
  const st = statSync(wav);
  return { source: realpathSync(wav), size: st.size, mtime_ms: Math.round(st.mtimeMs) };
}

/** Note that the stems `<base>-*.wav` in `stemsDir` were made from `wav` (call after a separation). */
export function recordSource(stemsDir: string, base: string, wav: string): void {
  // A new file, then a rename over the record: a link placed at the record's name is replaced, never written through.
  const target = recordPath(stemsDir, base);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(fingerprint(wav)) + "\n", { flag: "wx" });
  renameSync(tmp, target);
}

/** "match": the stems were made from this recording, unchanged since; "missing": no record (made before records, or
 * by hand); "other": another recording, or this one changed. */
export function sourceOf(stemsDir: string, base: string, wav: string): "match" | "missing" | "other" {
  let rec: Partial<SourceRecord>;
  try {
    const path = recordPath(stemsDir, base);
    if (!lstatSync(path).isFile()) return "missing"; // a link or folder is not a record gb-mcp wrote
    rec = JSON.parse(readFileSync(path, "utf8")) as Partial<SourceRecord>;
  } catch {
    return "missing";
  }
  const now = fingerprint(wav);
  return rec.source === now.source && rec.size === now.size && rec.mtime_ms === now.mtime_ms ? "match" : "other";
}
