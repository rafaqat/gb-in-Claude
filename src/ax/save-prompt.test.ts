// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { parseSavePrompt } from "./locators.js";

describe("parseSavePrompt (both macOS wordings)", () => {
  it.each([
    ["Do you want to save the document “Untitled 26”?", "Untitled 26"],
    ["Do you want to save the changes made to the document “Ascent-v4-session.band”?", "Ascent-v4-session.band"],
  ])("%s → %s", (text, doc) => {
    expect(parseSavePrompt(text)).toBe(doc);
  });

  it.each(["Your changes will be lost if you don’t save them.", "Do you want to delete “X”?", ""])("ignores %j", (text) => {
    expect(parseSavePrompt(text)).toBeUndefined();
  });
});
