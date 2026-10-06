// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { homedir } from "node:os";
import { resolve } from "node:path";

/** The workspace folder: GB_MCP_WORKSPACE when it is set and not blank (absolute against `cwd`), else ~/Music/gb-mcp.
 * eval/_paths.py reads the variable the same way, so the eval scripts and the server always agree. */
export function workspaceDir(env: Record<string, string | undefined> = process.env, cwd: string = process.cwd()): string {
  const v = env.GB_MCP_WORKSPACE?.trim();
  return v ? resolve(cwd, v) : resolve(homedir(), "Music", "gb-mcp");
}
