// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodTypeAny } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SongSchema } from "../song/schema.js";

type JsonObject = Record<string, unknown>;
export const SONG_SCHEMA_URI = "gb://schema/song";

const toJson = (schema: ZodTypeAny): JsonObject => {
  const { $schema: _drop, ...rest } = zodToJsonSchema(schema, { $refStrategy: "none", target: "jsonSchema7" }) as JsonObject;
  return rest;
};

/** JSON Schema of Song JSON, generated from the zod schema that validates it (single source of truth). */
export function songJsonSchema(): JsonObject {
  return zodToJsonSchema(SongSchema, { $refStrategy: "none", target: "jsonSchema7" }) as JsonObject;
}

type CommandOption = { shape: Record<string, ZodTypeAny & { value?: unknown }> } & ZodTypeAny;

/** One JSON Schema per command of a `command`-discriminated tool input (the discriminator itself is left out). */
function commandSchemas(input: ZodTypeAny): Record<string, JsonObject> {
  const options = ((input as unknown as { options?: CommandOption[] }).options ?? []);
  return Object.fromEntries(options.map((option) => {
    const command = String(option.shape.command?.value);
    const schema = toJson(option);
    const properties = { ...((schema.properties as Record<string, JsonObject>) ?? {}) };
    delete properties.command;
    if ("song" in properties) properties.song = { $ref: SONG_SCHEMA_URI, description: "Song JSON — the gb://schema/song document" };
    const required = ((schema.required as string[]) ?? []).filter((r) => r !== "command");
    // z.unknown() reads as optional in JSON Schema, but the tool rejects a missing song unless it is .optional()
    const song = option.shape.song as (ZodTypeAny & { _def: { typeName?: string } }) | undefined;
    if (song && song._def.typeName !== "ZodOptional" && !required.includes("song")) required.unshift("song");
    const { required: _original, ...rest } = schema;
    return [command, { ...rest, properties, ...(required.length ? { required } : {}) }];
  }));
}

/** tool → command → JSON Schema of its parameters, from each tool's zod input (what the server validates with). */
export function toolJsonSchemas(tools: Record<string, ZodTypeAny>): Record<string, { commands: Record<string, JsonObject> }> {
  return Object.fromEntries(Object.entries(tools).map(([name, input]) => [name, { commands: commandSchemas(input) }]));
}

/** Schema introspection resources: agents read exact parameters, types and enums at runtime (no guessing). */
export function registerSchemaResources(server: McpServer, opts: { tools: Record<string, ZodTypeAny> }): void {
  const json = (uri: string, value: unknown) => ({ contents: [{ uri, mimeType: "application/schema+json", text: JSON.stringify(value) }] });
  server.registerResource("schema-song", SONG_SCHEMA_URI,
    { description: "JSON Schema of Song JSON (generated from the validator)", mimeType: "application/schema+json" },
    async (uri) => json(uri.href, songJsonSchema()));
  server.registerResource("schema-tools", "gb://schema/tools",
    { description: "JSON Schema of every gb-mcp tool command's parameters: tool → commands → schema", mimeType: "application/schema+json" },
    async (uri) => json(uri.href, toolJsonSchemas(opts.tools)));
}
