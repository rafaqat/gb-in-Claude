// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { execFile } from "node:child_process";
import { ok, err, type Result } from "../result.js";
import type { ProjectDoc, ProjectScripts } from "./project.js";

/** Scripts are fixed text; every value travels through `argv` (never interpolated → no AppleScript injection). */
export const LIST_DOCUMENTS = [
  "on run argv",
  "set out to \"\"",
  "tell application \"GarageBand\"",
  "repeat with d in every document",
  "set out to out & (name of d) & tab & ((modified of d) as text) & linefeed",
  "end repeat",
  "end tell",
  "return out",
  "end run",
];

/** Saves a COPY of the document (it stays open, untitled) — used as the safety backup before discarding. */
export const BACKUP_DOCUMENT = [
  "on run argv",
  "tell application \"GarageBand\" to save document (item 1 of argv) in POSIX file (item 2 of argv)",
  "end run",
];

export function parseDocumentList(stdout: string): ProjectDoc[] {
  return stdout.split("\n").filter((l) => l.includes("\t")).map((l) => {
    const [name, modified] = l.split("\t");
    return { name: name!, modified: modified!.trim() === "true" };
  });
}

/** osascript's argv: each script line after -e, then the arguments the script's `run argv` receives. */
export function osascriptArgv(lines: readonly string[], args: readonly string[]): string[] {
  // "--" ends the options: a document named "-e…" would otherwise turn the next argument into script
  return [...lines.flatMap((l) => ["-e", l]), "--", ...args];
}

function osascript(lines: string[], args: string[], timeoutMs: number): Promise<Result<string, string>> {
  const argv = osascriptArgv(lines, args);
  return new Promise((resolve) => {
    execFile("osascript", argv, { timeout: timeoutMs, killSignal: "SIGKILL" }, (error, stdout, stderr) => {
      if (error) resolve(err((stderr || error.message).trim().slice(0, 300)));
      else resolve(ok(stdout));
    });
  });
}

export function createAppleScripts(timeoutMs = 30_000): ProjectScripts {
  return {
    async listDocuments() {
      const r = await osascript(LIST_DOCUMENTS, [], timeoutMs);
      return r.ok ? ok(parseDocumentList(r.value)) : r;
    },
    async backupDocument(name, path) {
      const r = await osascript(BACKUP_DOCUMENT, [name, path], timeoutMs);
      return r.ok ? ok(undefined) : r;
    },
  };
}

/**
 * `open -b com.apple.garageband10 <file>` — argv only. Not `-g` (open in the background): tried live, GarageBand
 * still comes forward for its own alerts (e.g. "Avoid feedback" on audio tracks), and the save-prompt path could not be
 * verified in the background — the open stays in the foreground, where every path is proven.
 */
export const openArgs = (path: string): string[] => ["-b", "com.apple.garageband10", path];

export function openInGarageBand(path: string): Promise<Result<void, string>> {
  return new Promise((resolve) => {
    execFile("open", openArgs(path), { timeout: 30_000 }, (error) => resolve(error ? err(error.message) : ok(undefined)));
  });
}
