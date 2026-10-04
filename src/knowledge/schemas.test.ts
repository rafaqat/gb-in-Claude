// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { songJsonSchema, toolJsonSchemas, registerSchemaResources } from "./schemas.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GbAnalyzeInput } from "../mcp/gb-analyze.js";
import { GbSongInput } from "../mcp/gb-song.js";
import { GbSoundInput } from "../mcp/gb-sound.js";
import { GbExportInput } from "../garageband/export.js";
import { ROLES } from "../song/schema.js";

type JsonSchema = {
  type?: string; required?: string[]; properties?: Record<string, JsonSchema>; items?: JsonSchema; enum?: unknown[];
  additionalProperties?: boolean; $ref?: string; default?: unknown;
};

describe("songJsonSchema", () => {
  it("describes Song JSON: required top-level fields and the enums agents must use", () => {
    const s = songJsonSchema() as JsonSchema;
    expect(s.type).toBe("object");
    expect(s.required).toEqual(expect.arrayContaining(["title", "tempo", "sections", "tracks"]));
    expect(s.properties!.style!.enum).toEqual(["club-trance", "acoustic", "orbit-ambient"]);
    expect(s.properties!.humanize!.enum).toEqual(["off", "tight", "natural", "loose"]);
    expect(s.properties!.tracks!.items!.properties!.role!.enum).toEqual([...ROLES]);
  });
});

describe("toolJsonSchemas", () => {
  const tools = toolJsonSchemas({ gb_song: GbSongInput, gb_sound: GbSoundInput, gb_export: GbExportInput }) as Record<string, { commands: Record<string, JsonSchema> }>;

  it("lists every command of every tool", () => {
    expect(Object.keys(tools.gb_song!.commands)).toEqual(["validate", "preview", "render_midi", "render_draft", "band_plan", "template", "infill"]);
    expect(Object.keys(tools.gb_sound!.commands)).toEqual(["patches", "plugins", "loops", "samples", "palette"]);
    expect(Object.keys(tools.gb_export!.commands)).toEqual(["song"]);
  });

  it("gives each command its parameters, types and required fields (without the command discriminator)", () => {
    const preview = tools.gb_song!.commands.preview!;
    expect(preview.required).toEqual(expect.arrayContaining(["song", "section"]));
    expect(preview.properties!.maxBars!.type).toBe("integer");
    expect(preview.properties).not.toHaveProperty("command");
    expect(tools.gb_song!.commands.render_midi!.properties!.dry_run!.type).toBe("boolean");
    expect(tools.gb_sound!.commands.loops!.additionalProperties).toBe(false); // strict: unknown params are rejected
    expect(tools.gb_export!.commands.song!.properties!.format!.default).toBe("WAVE");
  });

  it("never lists the command discriminator as required, even when a command has no required parameters", () => {
    for (const [name, cmd] of Object.entries(tools.gb_sound!.commands)) expect(cmd.required ?? [], name).not.toContain("command");
  });

  it("points song parameters at the Song JSON schema instead of an empty schema", () => {
    expect(tools.gb_song!.commands.validate!.properties!.song!.$ref).toBe("gb://schema/song");
  });
});

describe("registerSchemaResources", () => {
  it("serves gb://schema/song and gb://schema/tools to MCP clients", async () => {
    const server = new McpServer({ name: "t", version: "0" });
    registerSchemaResources(server, { tools: { gb_song: GbSongInput, gb_analyze: GbAnalyzeInput } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "c", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);

    const uris = (await client.listResources()).resources.map((r) => r.uri).sort();
    expect(uris).toEqual(["gb://schema/song", "gb://schema/tools"]);

    const tools = JSON.parse(((await client.readResource({ uri: "gb://schema/tools" })).contents[0] as { text: string }).text);
    expect(Object.keys(tools)).toEqual(["gb_song", "gb_analyze"]);
    expect(tools.gb_analyze.commands.compare.required).toEqual(["before", "after"]); // song is optional for compare
    const song = JSON.parse(((await client.readResource({ uri: "gb://schema/song" })).contents[0] as { text: string }).text);
    expect(song.required).toEqual(expect.arrayContaining(["title", "tracks"]));
  });
});
