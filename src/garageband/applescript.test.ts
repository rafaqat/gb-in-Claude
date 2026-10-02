// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { parseDocumentList, LIST_DOCUMENTS, BACKUP_DOCUMENT } from "./applescript.js";

describe("parseDocumentList", () => {
  it("parses tab-separated name / modified lines", () => {
    expect(parseDocumentList("Untitled 2\ttrue\nAscent-v4-session.band\tfalse\n")).toEqual([
      { name: "Untitled 2", modified: true },
      { name: "Ascent-v4-session.band", modified: false },
    ]);
  });

  it("ignores blank lines and returns [] for no documents", () => {
    expect(parseDocumentList("\n")).toEqual([]);
  });
});

describe("AppleScript sources", () => {
  it("take every value through argv — no string is ever spliced into the script", () => {
    for (const script of [LIST_DOCUMENTS, BACKUP_DOCUMENT]) {
      expect(script[0]).toBe("on run argv");
      expect(script.at(-1)).toBe("end run");
      expect(script.join("\n")).not.toMatch(/\$\{|%s/);
    }
    expect(BACKUP_DOCUMENT.join("\n")).toContain("item 1 of argv");
    expect(BACKUP_DOCUMENT.join("\n")).toContain("item 2 of argv");
  });
});
