// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { workspaceDir } from "./workspace.js";

// Code review 2026-10-06 (finding 7): an empty GB_MCP_WORKSPACE made the workspace the current folder, while the eval
// scripts (eval/_paths.py) treat empty as unset. Both now read it the same way.
describe("workspaceDir", () => {
  it("is GB_MCP_WORKSPACE, made absolute against the current folder", () => {
    expect(workspaceDir({ GB_MCP_WORKSPACE: "/tmp/ws" }, "/cwd")).toBe("/tmp/ws");
    expect(workspaceDir({ GB_MCP_WORKSPACE: "rel/ws" }, "/cwd")).toBe("/cwd/rel/ws");
  });

  it("is ~/Music/gb-mcp when GB_MCP_WORKSPACE is unset, empty or blank", () => {
    for (const env of [{}, { GB_MCP_WORKSPACE: "" }, { GB_MCP_WORKSPACE: "  " }]) {
      expect(workspaceDir(env, "/cwd")).toBe(resolve(homedir(), "Music", "gb-mcp"));
    }
  });
});
