// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { recordSource, sourceOf } from "./stem-source.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "stem-source-"));
  const wav = join(dir, "song.wav");
  writeFileSync(wav, "RIFF");
  return { dir, wav };
}

describe("stem source records", () => {
  it("records a source and matches it", () => {
    const { dir, wav } = setup();
    recordSource(dir, "song", wav);
    expect(sourceOf(dir, "song", wav)).toBe("match");
  });

  it("never writes through a link placed where the record goes", () => {
    const { dir, wav } = setup();
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "keep me");
    symlinkSync(victim, join(dir, "song.source.json"));
    recordSource(dir, "song", wav);
    expect(readFileSync(victim, "utf8")).toBe("keep me");
    expect(lstatSync(join(dir, "song.source.json")).isSymbolicLink()).toBe(false);
    expect(sourceOf(dir, "song", wav)).toBe("match");
  });

  it("does not trust a record that is a link", () => {
    const { dir, wav } = setup();
    const elsewhere = join(dir, "elsewhere.json");
    recordSource(dir, "other", wav); // a valid record, under another name
    writeFileSync(elsewhere, readFileSync(join(dir, "other.source.json")));
    symlinkSync(elsewhere, join(dir, "song.source.json"));
    expect(sourceOf(dir, "song", wav)).toBe("missing");
  });
});
