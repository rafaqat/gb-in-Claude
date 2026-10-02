#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
// gb-mcp stdio entry point. stdout is the JSON-RPC channel: never print to it. Logs go to stderr.
import { resolve } from "node:path";
import { homedir } from "node:os";
import { createPythonAnalyzer } from "./analysis/analyzer.js";
import { createGmRenderer } from "./render/gm-renderer.js";
import { createDefaultSystemDeps } from "./mcp/gb-system.js";
import { createAppleScripts, openInGarageBand } from "./garageband/applescript.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, SERVER_VERSION } from "./mcp/server.js";
import { mutationGate } from "./garageband/gate.js";

const workspaceDir = resolve(process.env.GB_MCP_WORKSPACE ?? resolve(homedir(), "Music", "gb-mcp"));
// One GarageBand mutation at a time across every gb-mcp process of this user (two Claude sessions, any workspace).
mutationGate.configure({ lockPath: resolve(homedir(), "Library", "Caches", "gb-mcp", "garageband.lock") });
console.log = (...args: unknown[]) => console.error(...args); // belt and braces: nothing reaches stdout

const packageRoot = resolve(import.meta.dirname, "..");
const python = process.env.GB_MCP_PYTHON ?? "python3";
const system = createDefaultSystemDeps({ workspaceDir, python });
const server = createServer({
  system,
  garageband: {
    scripts: createAppleScripts(),
    openFile: openInGarageBand,
    // the export inbox must be a recent place in GarageBand's save panel (export there once by hand; see the README)
    inboxDir: resolve(workspaceDir, process.env.GB_MCP_EXPORT_INBOX ?? "exports"),
    defaultExportDir: resolve(homedir(), "Music", "GarageBand"),
  },
  workspaceDir,
  analyzer: createPythonAnalyzer({ python, analysisDir: resolve(packageRoot, "analysis"), timeoutMs: 180_000 }),
  gmRenderer: createGmRenderer({ binary: resolve(packageRoot, "native/bin/gm-render"), timeoutMs: 300_000 }),
});
const shutdown = () => {
  const exit = () => process.exit(0);
  setTimeout(exit, 1000).unref(); // never hang on a stuck helper
  system.helper.close().then(exit, exit);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("end", shutdown); // client went away: stop the native helper too

await server.connect(new StdioServerTransport());
console.error(`[gb-mcp ${SERVER_VERSION}] stdio ready; workspace: ${workspaceDir}`);
