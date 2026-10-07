// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/**
 * Local folders that GarageBand writes into ProjectData (found 2026-10-06 when publishing examples): a project that
 * uses an Alchemy synth stores "DataLoc = /Users/<name>/…/<project>.band/Media/Alchemy Samples". gb-mcp's donors and
 * built .band files would carry the user's name and folders wherever they are shared. Each such value is replaced by
 * a neutral path of the SAME length (every record keeps its size), keeping the project's own "/<name>.band/…" tail;
 * GarageBand opened a project scrubbed this way and verified it.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseBinaryPlist } from "../sound/bplist.js";

const PREFIXES = ["/Users/", "/Volumes/", "/private/"].map((p) => new TextEncoder().encode(p));
const NEUTRAL = "/Users/Shared/gb-mcp";

/**
 * Also found in donors with audio regions: each audio file's folder, a NUL-terminated field
 * ("/Users/<name>/…/<project>.band/Media/Audio Files"). So every value that starts with a local prefix is scrubbed,
 * wherever it is; a value runs to the first control byte (UTF-8 bytes of a non-ASCII name are part of it).
 */
export function scrubLocalPaths(input: Uint8Array): { bytes: Uint8Array; replaced: number } {
  let bytes = input;
  let replaced = 0;
  for (let at = 0; at < bytes.length; at++) {
    if (bytes[at] !== 0x2f || !PREFIXES.some((p) => startsWith(bytes, p, at))) continue; // "/"
    let end = at;
    while (end < bytes.length && bytes[end]! >= 0x20 && bytes[end] !== 0x7f) end++;
    const value = new TextDecoder("latin1").decode(bytes.subarray(at, end)); // one char per byte: indexes are offsets
    const clean = scrubPath(value);
    if (clean !== value) {
      if (bytes === input) bytes = new Uint8Array(input); // copy on first change
      for (let i = 0; i < clean.length; i++) bytes[at + i] = clean.charCodeAt(i); // the tail's bytes are unchanged
      replaced++;
    }
    at = end;
  }
  return { bytes, replaced };
}

/** One path: a local head becomes NEUTRAL padded with "-" to the same length; the "/<name>.band/…" tail stays. */
export function scrubPath(value: string): string {
  if (!/^\/(Users|Volumes|private)\//.test(value) || value.startsWith(NEUTRAL)) return value;
  const tail = /\/[^/]+\.band\/.*$/.exec(value)?.[0] ?? "";
  const room = value.length - tail.length;
  return (room >= NEUTRAL.length ? NEUTRAL + "-".repeat(room - NEUTRAL.length) : "/" + "-".repeat(Math.max(0, room - 1))) + tail;
}

/**
 * MetaData.plist (a binary plist) lists the project's audio files in AudioFiles — as absolute paths in a project
 * GarageBand saved (found 2026-10-07 in a live check). Each is scrubbed with scrubPath and the list is written back
 * with plutil, as gb_band build already writes it. Returns how many paths changed; a file without local paths is
 * left untouched.
 */
export async function scrubMetaData(file: string): Promise<number> {
  const plist = parseBinaryPlist(new Uint8Array(readFileSync(file)));
  const list = plist.ok ? (plist.value as { AudioFiles?: unknown }).AudioFiles : undefined;
  if (!Array.isArray(list)) return 0;
  const clean = list.map((v) => (typeof v === "string" ? scrubPath(v) : v));
  const changed = clean.filter((v, i) => v !== list[i]).length;
  if (changed > 0) {
    await new Promise<void>((resolve, reject) =>
      execFile("plutil", ["-replace", "AudioFiles", "-json", JSON.stringify(clean), file], { timeout: 10_000 }, (e) => (e ? reject(e) : resolve())));
  }
  return changed;
}

function startsWith(hay: Uint8Array, needle: Uint8Array, at: number): boolean {
  if (at + needle.length > hay.length) return false;
  for (let j = 0; j < needle.length; j++) if (hay[at + j] !== needle[j]) return false;
  return true;
}
