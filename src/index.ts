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
import { existsSync } from "node:fs";
import { createModelSidecar } from "./models/sidecar.js";

const workspaceDir = resolve(process.env.GB_MCP_WORKSPACE ?? resolve(homedir(), "Music", "gb-mcp"));
// One GarageBand mutation at a time across every gb-mcp process of this user (two Claude sessions, any workspace).
mutationGate.configure({ lockPath: resolve(homedir(), "Library", "Caches", "gb-mcp", "garageband.lock") });
console.log = (...args: unknown[]) => console.error(...args); // belt and braces: nothing reaches stdout

const packageRoot = resolve(import.meta.dirname, "..");
const python = process.env.GB_MCP_PYTHON ?? "python3";
const system = createDefaultSystemDeps({ workspaceDir, python });
// M8 model sidecar (beats/grid, key, genre ranking for gb_analyze): only when its environment exists
const modelsDir = resolve(packageRoot, "models");
const modelsPython = resolve(modelsDir, ".venv", "bin", "python");
const listener = existsSync(modelsPython)
  ? createModelSidecar({ command: modelsPython, args: ["-m", "gbmodels.server"], cwd: modelsDir, timeoutMs: 120_000, startTimeoutMs: 120_000 })
  : undefined;
// M12b engines for gb_generate, each in its own venv (outside gb-mcp, at reviewed commits; see gb://knowledge/generate):
// a sidecar per installed engine, named with GBMODELS_ENV; a request may take most of an hour (a long song)
const engineCache = process.env.GB_MCP_ENGINE_HOME ?? resolve(homedir(), "Library", "Caches", "gb-mcp"); // scripts/install-engines.sh
const engineDirs = {
  ace_step: process.env.GB_MCP_ACESTEP ?? resolve(engineCache, "ace-step"),
  mulacover: process.env.GB_MCP_MULACOVER ?? resolve(engineCache, "mulacover"),
};
const engines = Object.fromEntries(Object.entries(engineDirs)
  .map(([name, dir]) => [name, resolve(dir, ".venv", "bin", "python")] as const)
  .filter(([, py]) => existsSync(py))
  .map(([name, py]) => [name, createModelSidecar({ command: py, args: ["-m", "gbmodels.server"], cwd: modelsDir, timeoutMs: 45 * 60_000,
    startTimeoutMs: 120_000, env: { GBMODELS_ENV: name.replace("_", "-") } })]));
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
  ...(listener ? { listener } : {}),
  engines,
  aceExamplesDir: resolve(engineDirs.ace_step, "examples", "text2music"),
});
const shutdown = () => {
  const exit = () => process.exit(0);
  setTimeout(exit, 1000).unref(); // never hang on a stuck helper
  listener?.close();
  for (const engine of Object.values(engines)) engine.close();
  system.helper.close().then(exit, exit);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("end", shutdown); // client went away: stop the native helper too

await server.connect(new StdioServerTransport());
console.error(`[gb-mcp ${SERVER_VERSION}] stdio ready; workspace: ${workspaceDir}`);
