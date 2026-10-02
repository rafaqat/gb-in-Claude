// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createGbSystem, registerSystemTools, GB_SYSTEM_COMMANDS, PANEL_NAMES, type GbSystemDeps } from "./gb-system.js";
import { FakeHelper } from "../ax/fake-helper.js";
import type { DoctorReport } from "../system/doctor.js";

const report: DoctorReport = {
  ready: true,
  checks: [{ name: "node.version", ok: true, severity: "required", detail: "Node 24.13.0" }],
  summary: { passed: 1, failed_required: [], failed_recommended: [] },
};
const deps = (helper = new FakeHelper(), over: Partial<GbSystemDeps> = {}): GbSystemDeps => ({
  helper,
  doctor: async () => report,
  toolRegistry: { gb_song: { description: "compose", commands: ["validate", "preview", "render_midi"] } },
  ...over,
});

describe("gb_system handler", () => {
  it("doctor returns the report; failed required checks become warnings", async () => {
    const sys = createGbSystem(deps());
    expect(await sys({ command: "doctor" })).toMatchObject({ status: "verified", op: "gb_system.doctor", data: { ready: true } });
    const bad = createGbSystem(deps(new FakeHelper(), {
      doctor: async () => ({ ...report, ready: false, summary: { passed: 0, failed_required: ["permission.accessibility"], failed_recommended: [] } }),
    }));
    expect(await bad({ command: "doctor" })).toMatchObject({ status: "verified", data: { ready: false }, warnings: [expect.stringContaining("permission.accessibility")] });
  });

  it("describe lists gb_system's commands with parameter schemas, the panels, and the other tools", async () => {
    const r = await createGbSystem(deps())({ command: "describe" });
    expect(r.status).toBe("verified");
    const data = (r as { data: { commands: Record<string, { params: Record<string, unknown> }>; panels: { name: string }[]; tools: Record<string, unknown> } }).data;
    expect(Object.keys(data.commands)).toEqual([...GB_SYSTEM_COMMANDS]);
    expect(data.commands.ui_snapshot!.params).toMatchObject({ panel: { type: "string", required: true, enum: PANEL_NAMES } });
    expect(data.panels.map((p) => p.name)).toEqual(PANEL_NAMES);
    expect(data.tools).toMatchObject({ gb_song: { commands: ["validate", "preview", "render_midi"] } });
  });

  it("ui_snapshot returns a compact, scoped, read-only snapshot of a named panel", async () => {
    const helper = new FakeHelper();
    const r = await createGbSystem(deps(helper))({ command: "ui_snapshot", panel: "playhead" });
    expect(r).toMatchObject({ status: "verified", data: { panel: "playhead", garageband: "10.4.14", root: { desc: "Playhead Position" } } });
    expect(helper.calls.every((c) => ["app.state", "ax.snapshot"].includes(c.op))).toBe(true);
  });

  it("ui_snapshot caps nodes", async () => {
    const r = await createGbSystem(deps())({ command: "ui_snapshot", panel: "control-bar", max_nodes: 5 });
    expect(r).toMatchObject({ status: "verified", data: { node_count: 5, truncated: true } });
  });

  it("ui_snapshot refuses an unsupported GarageBand version instead of guessing locators", async () => {
    const helper = new FakeHelper();
    helper.app.installed = { path: "/Applications/GarageBand.app", version: "10.4.15", build: "1" };
    expect(await createGbSystem(deps(helper))({ command: "ui_snapshot", panel: "playhead" })).toMatchObject({ status: "failed", error: "GB_VERSION_UNSUPPORTED" });
  });

  it("ui_snapshot when GarageBand is not running", async () => {
    const helper = new FakeHelper();
    helper.app.running = false;
    expect(await createGbSystem(deps(helper))({ command: "ui_snapshot", panel: "playhead" })).toMatchObject({ status: "failed", error: "GB_NOT_RUNNING" });
  });

  it.each([
    [{ command: "ui_snapshot", panel: "desktop" }],
    [{ command: "ui_snapshot" }],
    [{ command: "ui_snapshot", panel: "playhead", max_nodes: 100_000 }],
    [{ command: "press_everything" }],
  ])("rejects invalid input %j", async (input) => {
    expect(await createGbSystem(deps())(input)).toMatchObject({ status: "failed", error: "INPUT_INVALID" });
  });
});

describe("registerSystemTools", () => {
  it("registers gb_system on an MCP server; failures are isError, successes structured", async () => {
    const server = new McpServer({ name: "t", version: "0" });
    registerSystemTools(server, deps());
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "c", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);

    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "gb_system")!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(JSON.stringify(tool.inputSchema)).toContain("ui_snapshot");

    const ok = await client.callTool({ name: "gb_system", arguments: { command: "ui_snapshot", panel: "playhead" } });
    expect(ok.isError).toBeFalsy();
    expect(ok.structuredContent).toMatchObject({ status: "verified" });
    const bad = await client.callTool({ name: "gb_system", arguments: { command: "ui_snapshot", panel: "desktop" } });
    expect(bad.isError).toBe(true);
  });
});
