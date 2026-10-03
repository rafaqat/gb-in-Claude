// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { ok, err, type Result } from "../result.js";

export type PathError = {
  code: "PATH_INVALID" | "PATH_OUTSIDE_WORKSPACE" | "FILE_NOT_FOUND" | "NOT_SUPPORTED";
  message: string;
};

/** Shapes agents hallucinate in paths: percent-encoding, query/fragment, control characters. */
const SUSPICIOUS = /%[0-9a-fA-F]{2}|[?#]|[\u0000-\u001f\u007f]/;

const inside = (root: string, candidate: string) => candidate === root || candidate.startsWith(root + sep);

/** An existing path inside the workspace (after following symlinks), or why not. */
function resolveInside(workspace: string, input: string): Result<string, PathError> {
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
  return ok(real);
}

/**
 * A folder for gb-mcp's own output, `rel` inside the workspace: made when missing (with `create`), and it must still
 * be inside the workspace after following links — a linked `bands/` must not carry writes elsewhere.
 */
export function workspaceOutputDir(workspace: string, rel: string, create: boolean): Result<string, PathError> {
  const path = join(workspace, rel);
  if (create && !existsSync(path)) {
    // check BEFORE mkdir: the nearest folder that exists must already be inside the workspace, or a linked
    // `bands/` would get the new folder made elsewhere, and a refusal afterwards cannot take it back
    let parent = dirname(path);
    while (!existsSync(parent) && parent !== dirname(parent)) parent = dirname(parent);
    if (!inside(realpathSync(workspace), realpathSync(parent))) {
      return err({ code: "PATH_OUTSIDE_WORKSPACE", message: "the folder would be made (via a link) outside the workspace" });
    }
    try {
      mkdirSync(path, { recursive: true });
    } catch {
      return err({ code: "PATH_INVALID", message: "the folder cannot be made" });
    }
  }
  const at = resolveInside(workspace, rel);
  if (!at.ok) return at;
  if (!statSync(at.value).isDirectory()) return err({ code: "PATH_INVALID", message: "not a folder" });
  return ok(at.value);
}

/** Resolve an existing GarageBand project package (a .band folder with Alternatives/000/ProjectData) inside the workspace. */
export function resolveWorkspaceBand(workspace: string, input: string): Result<string, PathError> {
  const at = resolveInside(workspace, input);
  if (!at.ok) return at;
  const real = at.value;
  if (extname(real).toLowerCase() !== ".band" || !statSync(real).isDirectory() || !existsSync(join(real, "Alternatives", "000", "ProjectData"))) {
    return err({ code: "NOT_SUPPORTED", message: "not a GarageBand project (a .band package with Alternatives/000/ProjectData)" });
  }
  return ok(real);
}

/**
 * Resolve an existing file that must live inside the workspace (after following symlinks).
 * The agent is not a trusted operator: refuse anything else with a precise code.
 */
export function resolveWorkspaceFile(workspace: string, input: string, extensions: readonly string[]): Result<string, PathError> {
  const at = resolveInside(workspace, input);
  if (!at.ok) return at;
  const real = at.value;
  if (!statSync(real).isFile()) return err({ code: "FILE_NOT_FOUND", message: "not a file" });
  if (!extensions.includes(extname(real).toLowerCase())) {
    return err({ code: "NOT_SUPPORTED", message: `unsupported file type; use one of ${extensions.join(", ")}` });
  }
  return ok(real);
}
