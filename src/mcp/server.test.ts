// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";
import { FakeHelper } from "../ax/fake-helper.js";
import { ok } from "../result.js";

let client: Client;
beforeAll(async () => {
  const analyzer = { analyze: async () => ({ ok: false as const, error: { code: "AUDIO_INVALID" as const, message: "fake" } }) };
  const doctor = async () => ({ ready: true, checks: [], summary: { passed: 0, failed_required: [], failed_recommended: [] } }) as never;
  const server = createServer({ workspaceDir: mkdtempSync(join(tmpdir(), "gbmcp-srv-")), analyzer, system: { helper: new FakeHelper(), doctor } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
});

const song = {
  title: "T", tempo: 120,
  sections: [{ name: "a", bars: 1 }],
  tracks: [{ name: "Lead", role: "lead", parts: { a: { notes: "c5 e5" } } }],
};

describe("gb-mcp server", () => {
  it("lists gb_song with a command enum in its input schema", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "gb_song");
    expect(tool).toBeDefined();
    expect(JSON.stringify(tool!.inputSchema)).toContain("render_midi");
  });

  it("returns the envelope as structuredContent and compact JSON text", async () => {
    const r = await client.callTool({ name: "gb_song", arguments: { command: "validate", song } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ status: "verified", op: "gb_song.validate" });
    const text = (r.content as { type: string; text: string }[])[0]!.text;
    expect(JSON.parse(text)).toEqual(r.structuredContent);
    expect(text).not.toContain("\n");
  });

  it("marks failed envelopes with isError", async () => {
    const r = await client.callTool({ name: "gb_song", arguments: { command: "validate", song: { title: "x" } } });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ status: "failed", error: "SONG_INVALID" });
  });

  it("gb_system describe lists every tool's commands", async () => {
    const r = await client.callTool({ name: "gb_system", arguments: { command: "describe" } });
    const text = JSON.stringify(r.structuredContent);
    for (const cmd of ["render_draft", "against_song", "palette", "doctor"]) expect(text).toContain(cmd);
  });

  it("lists the composition, analysis, sound-catalog and system tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["gb_analyze", "gb_song", "gb_sound", "gb_system"]);
  });

  it("serves agent knowledge resources: song format, styles, GM patch map, analysis guide, production rubric", async () => {
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual([
      "gb://knowledge/analysis", "gb://knowledge/gm-patch-map", "gb://knowledge/production",
      "gb://knowledge/song-format", "gb://knowledge/styles", "gb://schema/song", "gb://schema/tools",
    ]);
    const styles = await client.readResource({ uri: "gb://knowledge/styles" });
    expect((styles.contents[0] as { text: string }).text).toContain("orbit-ambient");
  });
});

describe("gb-mcp server with GarageBand operations", () => {
  let gb: Client;
  beforeAll(async () => {
    const ws = mkdtempSync(join(tmpdir(), "gbmcp-srv4-"));
    const doctor = async () => ({ ready: true, checks: [], summary: { passed: 0, failed_required: [], failed_recommended: [] } }) as never;
    const server = createServer({
      workspaceDir: ws, system: { helper: new FakeHelper(), doctor },
      garageband: {
        scripts: { listDocuments: async () => ok([]), backupDocument: async () => ok(undefined) },
        openFile: async () => undefined, inboxDir: join(ws, "probe-export"), screenLocked: async () => false,
      },
      patchCatalog: async () => ok([]),
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    gb = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(a), gb.connect(b)]);
  });

  it("lists the GarageBand tools: project, export, tracks, transport, mix", async () => {
    const names = (await gb.listTools()).tools.map((t) => t.name);
    for (const t of ["gb_project", "gb_export", "gb_tracks", "gb_transport", "gb_mix"]) expect(names).toContain(t);
  });

  it("publishes every command's exact parameters as JSON Schema (gb://schema/tools)", async () => {
    const r = await gb.readResource({ uri: "gb://schema/tools" });
    const tools = JSON.parse((r.contents[0] as { text: string }).text);
    expect(tools.gb_tracks.commands.set_instrument.required).toEqual(expect.arrayContaining(["track", "patch"]));
    expect(tools.gb_mix.commands.set_volume.properties).toHaveProperty("db");
    expect(tools.gb_transport.commands.set_count_in.properties.bars).toBeDefined();
    expect(tools.gb_project.commands.open_midi.properties).toHaveProperty("dry_run");
  });

  it("serves gb_tracks list end to end", async () => {
    const r = await gb.callTool({ name: "gb_tracks", arguments: { command: "list" } });
    expect(r.structuredContent).toMatchObject({ status: "verified", data: { tracks: [{ number: 1 }, { number: 2 }] } });
  });

  it("an unknown key (a hallucinated `dryRun`) is rejected at the MCP boundary — nothing runs", async () => {
    const r = await gb.callTool({ name: "gb_tracks", arguments: { command: "select", track: 2, dryRun: true } });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toMatch(/dryRun/);
    for (const name of ["gb_project", "gb_export", "gb_tracks", "gb_transport", "gb_mix"]) {
      const tool = (await gb.listTools()).tools.find((t) => t.name === name)!;
      expect(tool.inputSchema.additionalProperties, name).toBe(false);
    }
  });

  it("annotates honestly: every tool that changes existing GarageBand state is destructive; export (never overwrites) is not", async () => {
    const tools = (await gb.listTools()).tools;
    const hint = (n: string) => tools.find((t) => t.name === n)!.annotations?.destructiveHint;
    expect([hint("gb_project"), hint("gb_tracks"), hint("gb_transport"), hint("gb_mix"), hint("gb_export")]).toEqual([true, true, true, true, false]);
  });

  it("a handler that throws still answers with a sanitized envelope, never raw error text", async () => {
    const ws = mkdtempSync(join(tmpdir(), "gbmcp-srv5-"));
    const doctor = async () => ({ ready: true, checks: [], summary: { passed: 0, failed_required: [], failed_recommended: [] } }) as never;
    const server = createServer({
      workspaceDir: ws, system: { helper: new FakeHelper(), doctor },
      garageband: { scripts: { listDocuments: async () => ok([]), backupDocument: async () => ok(undefined) }, openFile: async () => undefined, inboxDir: join(ws, "probe-export"), screenLocked: async () => false },
      patchCatalog: async () => { throw new Error(`boom ${String.fromCodePoint(0x202e)}at /Users/x`); },
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(a), c.connect(b)]);
    const r = await c.callTool({ name: "gb_tracks", arguments: { command: "set_instrument", track: 1, patch: "Liverpool Bass" } });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ status: "failed", op: "gb_tracks", error: "INTERNAL_ERROR", write_attempted: true, safe_to_retry: false });
    expect(JSON.stringify(r)).not.toContain(String.fromCodePoint(0x202e));
  });
});
