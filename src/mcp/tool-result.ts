// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { failed, isErrorEnvelope, type Envelope } from "./envelope.js";
import { cleanText } from "../sound/text.js";

/** Longest single string an envelope may carry (protects the agent's context window). */
const MAX_STRING = 20_000;
/** Everything invisible except newline and tab (ASCII previews are multi-line): Cc/Cf, variation selectors, tags. */
const INVISIBLE_KEEP_LINES = /(?![\n\t])[\p{Cc}\p{Cf}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu;

/**
 * Every string that leaves gb-mcp passes here: GarageBand UI text, disk names and helper output are untrusted and may
 * carry invisible characters or hidden ("tag") text. Structure and newlines are kept.
 */
export function sanitizeOutput<T>(value: T): T {
  if (typeof value === "string") {
    const clean = value.replace(INVISIBLE_KEEP_LINES, "");
    return (clean.length > MAX_STRING ? `${clean.slice(0, MAX_STRING - 1)}…` : clean) as T;
  }
  if (Array.isArray(value)) return value.map(sanitizeOutput) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [sanitizeOutput(k), sanitizeOutput(v)])) as T;
  }
  return value;
}

/** Envelope → MCP tool result: compact JSON text + structuredContent; isError only for failures. */
export const toolResult = (raw: Envelope) => {
  const envelope = sanitizeOutput(raw);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(envelope) }],
    structuredContent: envelope as unknown as Record<string, unknown>,
    ...(isErrorEnvelope(envelope) ? { isError: true } : {}),
  };
};

/**
 * Wrap a tool handler: its envelope goes out through the sanitizer, and an unexpected throw becomes a failed
 * envelope too (the MCP SDK would otherwise return the raw error text). Whether a write
 * happened is unknown after a throw: a mutating tool says so and forbids blind retries.
 */
export const guarded = <A>(tool: string, handler: (args: A) => Promise<Envelope>, mutates: boolean) =>
  async (args: A) => {
    try {
      return toolResult(await handler(args));
    } catch (e) {
      return toolResult(failed(tool, "INTERNAL_ERROR", "the tool failed unexpectedly", {
        write_attempted: mutates, safe_to_retry: !mutates, recoverable: false,
        hint: mutates ? "check the state (gb_project status / the workspace) before retrying" : "retry once; if it persists run gb_system doctor",
        context: { detail: cleanText(e instanceof Error ? e.message : String(e), 200) },
      }));
    }
  };
