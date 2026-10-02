// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { existsSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, resolve, sep } from "node:path";
import { ok, err, type Result } from "../result.js";

export type PathError = {
  code: "PATH_INVALID" | "PATH_OUTSIDE_WORKSPACE" | "FILE_NOT_FOUND" | "NOT_SUPPORTED";
  message: string;
};

/** Shapes agents hallucinate in paths: percent-encoding, query/fragment, control characters. */
const SUSPICIOUS = /%[0-9a-fA-F]{2}|[?#]|[\u0000-\u001f\u007f]/;

const inside = (root: string, candidate: string) => candidate === root || candidate.startsWith(root + sep);

/**
 * Resolve an existing file that must live inside the workspace (after following symlinks).
 * The agent is not a trusted operator: refuse anything else with a precise code.
 */
export function resolveWorkspaceFile(workspace: string, input: string, extensions: readonly string[]): Result<string, PathError> {
  if (input.length === 0 || SUSPICIOUS.test(input)) {
    return err({ code: "PATH_INVALID", message: "path is empty or contains encoded, query/fragment or control characters" });
  }
  const root = realpathSync(workspace);
  const candidate = resolve(root, input);
  if (!inside(root, candidate) && !(isAbsolute(input) && inside(workspace, candidate))) {
    return err({ code: "PATH_OUTSIDE_WORKSPACE", message: "path must be inside the workspace" });
  }
  if (!existsSync(candidate)) return err({ code: "FILE_NOT_FOUND", message: "no such file in the workspace" });
  const real = realpathSync(candidate);
  if (!inside(root, real)) return err({ code: "PATH_OUTSIDE_WORKSPACE", message: "path resolves (via a link) outside the workspace" });
  if (!statSync(real).isFile()) return err({ code: "FILE_NOT_FOUND", message: "not a file" });
  if (!extensions.includes(extname(real).toLowerCase())) {
    return err({ code: "NOT_SUPPORTED", message: `unsupported file type; use one of ${extensions.join(", ")}` });
  }
  return ok(real);
}
