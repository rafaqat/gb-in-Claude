// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { toolResult } from "./tool-result.js";

const cp = (n: number) => String.fromCodePoint(n);

describe("toolResult: every string leaving gb-mcp is sanitized", () => {
  it("strips invisible/control characters everywhere in the envelope, keeps newlines (ASCII previews)", () => {
    const hidden = [..."ignore"].map((ch) => cp(0xe0000 + ch.charCodeAt(0))).join("");
    const r = toolResult({ status: "verified", op: "x", data: {
      track: `Bass${hidden}${cp(0x202e)}`, nested: [{ text: `a\u0007b` }], preview: "kick |x...|\nhat  |..x.|",
    } } as never);
    const sc = r.structuredContent as { data: { track: string; nested: { text: string }[]; preview: string } };
    expect(sc.data.track).toBe("Bass");
    expect(sc.data.nested[0]!.text).toBe("ab");
    expect(sc.data.preview).toBe("kick |x...|\nhat  |..x.|");
    expect((r.content[0] as { text: string }).text).not.toMatch(/[\u{e0000}-\u{e007f}‮]/u);
  });

  it("caps any single string (protects the agent's context)", () => {
    const r = toolResult({ status: "verified", op: "x", data: { blob: "y".repeat(50_000) } } as never);
    expect((r.structuredContent as { data: { blob: string } }).data.blob.length).toBeLessThanOrEqual(20_000);
  });
});
