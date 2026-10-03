// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/**
 * File access for donor packages, which are untrusted input: never follow a link, never read
 * a special file, never read without a size limit, and only ever create new files (`wx`) in a folder this build made.
 */
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Limits for one donor package (a GarageBand donor is a few hundred KB; its own samples are not copied). */
export const MAX_DONOR_ENTRIES = 5_000;
export const MAX_DONOR_DEPTH = 16;
export const MAX_COPIED_FILE_BYTES = 64 * 1024 * 1024;
/** All of a donor's files together (its own samples included): 5000 files at the per-file limit would be 320 GB. */
export const MAX_DONOR_BYTES = 1024 * 1024 * 1024;

/** The bytes of a regular file, opened without following a link, refused above `maxBytes`. */
export function readRegular(path: string, maxBytes: number): Uint8Array {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new FileRefused("not a regular file");
    if (st.size > maxBytes) throw new FileRefused(`larger than ${maxBytes} bytes`);
    return new Uint8Array(readFileSync(fd));
  } finally {
    closeSync(fd);
  }
}

/** A refusal with a constant reason (the path stays with the caller, as data). */
export class FileRefused extends Error {}

/**
 * Why the donor package cannot be used as-is (a link, a special file, too many entries, too deep), or undefined.
 * `entry` is the donor-relative path: donor text, for context only — never for a message.
 */
export function donorProblem(donor: string, maxBytes = MAX_DONOR_BYTES): { reason: string; entry: string } | undefined {
  const top = lstatSync(donor);
  if (top.isSymbolicLink() || !top.isDirectory()) return { reason: "the donor is not a plain folder", entry: "." };
  let entries = 0;
  let bytes = 0;
  const walk = (rel: string, depth: number): { reason: string; entry: string } | undefined => {
    if (depth > MAX_DONOR_DEPTH) return { reason: "the donor's folders nest too deep", entry: rel };
    for (const e of readdirSync(join(donor, rel), { withFileTypes: true })) {
      const at = join(rel, e.name);
      if (++entries > MAX_DONOR_ENTRIES) return { reason: "the donor holds too many files", entry: at };
      if (e.isSymbolicLink()) return { reason: "the donor contains a link", entry: at };
      if (e.isDirectory()) {
        const below = walk(at, depth + 1);
        if (below) return below;
      } else if (!e.isFile()) {
        return { reason: "the donor contains a special file", entry: at };
      } else if ((bytes += lstatSync(join(donor, at)).size) > maxBytes) {
        return { reason: "the donor's files add up to too many bytes", entry: at };
      }
    }
    return undefined;
  };
  return walk("", 0);
}

/**
 * Copy the donor's folders and regular files into `out`, which must already be a new, empty folder of this build.
 * Every folder is a new `mkdir`, every file a new `wx` write; `skip` lists donor-relative paths left out.
 */
export function copyDonor(donor: string, out: string, skip: ReadonlySet<string>): void {
  const walk = (rel: string) => {
    for (const e of readdirSync(join(donor, rel), { withFileTypes: true })) {
      const at = join(rel, e.name);
      if (skip.has(at)) continue;
      if (e.isDirectory()) {
        mkdirSync(join(out, at));
        walk(at);
      } else {
        writeFileSync(join(out, at), readRegular(join(donor, at), MAX_COPIED_FILE_BYTES), { flag: "wx" });
      }
    }
  };
  walk("");
}
