// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { z } from "zod";
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { verified, failed, type Envelope } from "./envelope.js";
import { guarded } from "./tool-result.js";
import { AxCore } from "../ax/core.js";
import { GB_10_4_14, locatorsFor, SUPPORTED_GARAGEBAND_VERSIONS } from "../ax/locators.js";
import type { HelperPort } from "../native/helper-port.js";
import { HelperClient, DEFAULT_HELPER_PATH } from "../native/helper-client.js";
import { callOp, AppStateResult } from "../native/protocol.js";
import { runDoctor, type DoctorReport, type ExecResult } from "../system/doctor.js";

/** Panels ui_snapshot can scope to (names are stable across GarageBand versions; roots come from the locator set). */
export const PANEL_NAMES = Object.keys(GB_10_4_14.panels);

type ParamSpec = {
  type: "string" | "integer" | "boolean";
  required?: boolean;
  description: string;
  enum?: readonly string[];
  min?: number;
  max?: number;
  default?: unknown;
};
type CommandSpec = { description: string; params: Record<string, ParamSpec> };

/** Single source of truth: drives validation (zod) AND `describe` (machine-readable schema for agents). */
const COMMANDS = {
  doctor: {
    description: "Check the environment: native helper, macOS permissions (never prompts), GarageBand install/version/state, analysis toolchain, workspace. ready = all required checks pass.",
    params: {},
  },
  describe: {
    description: "Machine-readable description of gb_system's commands and parameters, the UI panels it knows, and the other gb-mcp tools' commands.",
    params: {},
  },
  ui_snapshot: {
    description: "Read-only compact snapshot of one GarageBand UI panel (accessibility tree), depth- and node-capped. Use it to see what is on screen before acting.",
    params: {
      panel: { type: "string", required: true, enum: PANEL_NAMES, description: "Which panel to snapshot" },
      depth: { type: "integer", min: 1, max: 12, description: "Tree depth (default: the panel's own default)" },
      max_nodes: { type: "integer", min: 1, max: 1_500, default: 250, description: "Node cap (protects the context window)" },
      include_help: { type: "boolean", default: false, description: "Include AX help strings (verbose)" },
    },
  },
} as const satisfies Record<string, CommandSpec>;

export const GB_SYSTEM_COMMANDS = Object.keys(COMMANDS) as (keyof typeof COMMANDS)[];

function zodFor(spec: ParamSpec): z.ZodTypeAny {
  let t: z.ZodTypeAny;
  if (spec.type === "string") t = spec.enum ? z.enum(spec.enum as [string, ...string[]]) : z.string();
  else if (spec.type === "integer") {
    let n = z.number().int();
    if (spec.min !== undefined) n = n.min(spec.min);
    if (spec.max !== undefined) n = n.max(spec.max);
    t = n;
  } else t = z.boolean();
  return spec.required ? t : t.optional();
}

const commandSchemas = GB_SYSTEM_COMMANDS.map((name) =>
  z.object({
    command: z.literal(name),
    ...Object.fromEntries(Object.entries(COMMANDS[name].params as Record<string, ParamSpec>).map(([k, s]) => [k, zodFor(s)])),
  }).strict(),
);
export const GbSystemInput = z.discriminatedUnion("command", commandSchemas as unknown as [z.AnyZodObject, z.AnyZodObject, ...z.AnyZodObject[]]);

export type ToolRegistry = Record<string, { description?: string; commands: readonly string[] }>;
export type GbSystemDeps = {
  helper: HelperPort;
  doctor: () => Promise<DoctorReport>;
  /** Other gb-mcp tools, listed by `describe` (gb_song, gb_analyze, gb_sound, …). */
  toolRegistry?: ToolRegistry;
};

export function createGbSystem(deps: GbSystemDeps) {
  const ax = new AxCore(deps.helper);

  return async function gbSystem(input: unknown): Promise<Envelope> {
    const parsed = GbSystemInput.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      return failed("gb_system", "INPUT_INVALID", `${issue.path.join(".") || "command"}: ${issue.message}`, {
        hint: `commands: ${GB_SYSTEM_COMMANDS.join(", ")}; panels: ${PANEL_NAMES.join(", ")} (gb_system describe has the full schema)`,
      });
    }
    const cmd = parsed.data as { command: keyof typeof COMMANDS; panel?: string; depth?: number; max_nodes?: number; include_help?: boolean };
    const op = `gb_system.${cmd.command}`;

    switch (cmd.command) {
      case "doctor": {
        const report = await deps.doctor();
        return verified(op, report, report.summary.failed_required.map((n) => `required check failed: ${n}`));
      }

      case "describe":
        return verified(op, {
          tool: "gb_system",
          commands: Object.fromEntries(GB_SYSTEM_COMMANDS.map((name) => [name, {
            description: COMMANDS[name].description,
            params: Object.fromEntries(Object.entries(COMMANDS[name].params as Record<string, ParamSpec>).map(([k, s]) => [k, { ...s, required: s.required === true }])),
          }])),
          panels: PANEL_NAMES.map((name) => ({ name, description: GB_10_4_14.panels[name]!.description, evidence: GB_10_4_14.panels[name]!.evidence })),
          supported_garageband: SUPPORTED_GARAGEBAND_VERSIONS,
          tools: deps.toolRegistry ?? {},
        });

      case "ui_snapshot": {
        const state = await callOp(deps.helper, "app.state", {}, AppStateResult, { deadlineMs: 3_000 });
        if (!state.ok) {
          return failed(op, state.error.code === "HELPER_UNAVAILABLE" ? "HELPER_UNAVAILABLE" : "HELPER_PROTOCOL_ERROR", state.error.message, {
            hint: "gb_system doctor shows what is missing",
          });
        }
        if (!state.value.ax_trusted) return failed(op, "PERMISSION_AX_DENIED", "Accessibility is not granted", { hint: "gb_system doctor shows how to grant it" });
        if (!state.value.running) return failed(op, "GB_NOT_RUNNING", "GarageBand is not running", { hint: "open GarageBand first, e.g. open -a GarageBand <rendered.mid>" });
        const version = state.value.installed?.version ?? null;
        const locators = locatorsFor(version);
        if (!locators) {
          return failed(op, "GB_VERSION_UNSUPPORTED", `GarageBand ${version ?? "unknown"} has no verified locator set (supported: ${SUPPORTED_GARAGEBAND_VERSIONS.join(", ")})`, {
            recoverable: false, hint: "UI locators are version-specific; probe this version before relying on UI automation",
          });
        }
        const panel = locators.panels[cmd.panel!]!;
        const snap = await ax.snapshot(op, panel.root, { depth: cmd.depth ?? panel.depth, maxNodes: cmd.max_nodes ?? 250, includeHelp: cmd.include_help === true });
        if (snap.status !== "verified") return snap;
        return verified(op, { panel: cmd.panel, garageband: version, evidence: panel.evidence, ...(snap.data as object) });
      }
    }
  };
}

/** Register the gb_system tool. Read-only: it never presses, sets or opens anything in GarageBand. */
export function registerSystemTools(server: McpServer, deps: GbSystemDeps): void {
  const handler = createGbSystem(deps);
  server.registerTool(
    "gb_system",
    {
      title: "gb-mcp system: doctor, describe, UI snapshot",
      description:
        "Environment and introspection (read-only). doctor: are the native helper, macOS permissions, GarageBand and the " +
        "analysis toolchain ready (with fixes)? describe: machine-readable command schemas for gb_system and the other " +
        "gb-mcp tools. ui_snapshot: compact accessibility snapshot of one GarageBand panel " +
        `(${PANEL_NAMES.join(", ")}).`,
      inputSchema: z.object({
        command: z.enum(GB_SYSTEM_COMMANDS as [string, ...string[]]),
        panel: z.enum(PANEL_NAMES as [string, ...string[]]).optional().describe("ui_snapshot: panel name"),
        depth: z.number().int().optional().describe("ui_snapshot: tree depth 1–12"),
        max_nodes: z.number().int().optional().describe("ui_snapshot: node cap 1–1500 (default 250)"),
        include_help: z.boolean().optional().describe("ui_snapshot: include AX help strings"),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guarded("gb_system", handler, false),
  );
}

// ---------------------------------------------------------------------------------------------- production wiring

/** Run a program with an argv array (no shell), a timeout and an output cap. */
export function execArgv(file: string, args: string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolvePromise) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 1_000_000, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === "ENOENT") return resolvePromise({ ok: false, error: `${file} not found` });
      if (error && error.killed) return resolvePromise({ ok: false, error: `${file} timed out after ${timeoutMs} ms` });
      // codesign --display exits 0 and writes to stderr; a non-zero exit with output is still informative
      if (error && !stdout && !stderr) return resolvePromise({ ok: false, error: error.message });
      resolvePromise({ ok: true, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function dirWritable(dir: string): boolean {
  let d = resolve(dir);
  while (!existsSync(d)) {
    const parent = dirname(d);
    if (parent === d) return false;
    d = parent;
  }
  try {
    accessSync(d, constants.W_OK);
    return statSync(d).isDirectory();
  } catch {
    return false;
  }
}

function fileInfo(path: string): { exists: boolean; executable: boolean } {
  if (!existsSync(path)) return { exists: false, executable: false };
  try {
    accessSync(path, constants.X_OK);
    return { exists: true, executable: true };
  } catch {
    return { exists: true, executable: false };
  }
}

/** Real dependencies for gb_system: one persistent HelperClient, doctor with argv-only subprocesses. */
export function createDefaultSystemDeps(opts: { workspaceDir: string; helperPath?: string; helper?: HelperPort; toolRegistry?: ToolRegistry; python?: string }): GbSystemDeps & { helper: HelperPort } {
  const helperPath = opts.helperPath ?? DEFAULT_HELPER_PATH;
  const helper = opts.helper ?? new HelperClient({ command: helperPath });
  return {
    helper,
    ...(opts.toolRegistry ? { toolRegistry: opts.toolRegistry } : {}),
    doctor: () => runDoctor({
      helper, helperPath, workspaceDir: opts.workspaceDir, nodeVersion: process.versions.node,
      supportedVersions: SUPPORTED_GARAGEBAND_VERSIONS, exec: execArgv, fileInfo, dirWritable,
      ...(opts.python ? { python: opts.python } : {}),
    }),
  };
}
