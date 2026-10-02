// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSamples } from "./samples.js";

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "gbsound-"));
});

describe("listSamples", () => {
  it("lists audio files under <workspace>/samples recursively, ignoring non-audio and all symlinks", () => {
    mkdirSync(join(ws, "samples", "drums"), { recursive: true });
    writeFileSync(join(ws, "samples", "kick.wav"), "RIFF0000");
    writeFileSync(join(ws, "samples", "drums", "snare.aif"), "FORM00");
    writeFileSync(join(ws, "samples", "notes.txt"), "not audio");
    symlinkSync("/etc/hosts", join(ws, "samples", "evil.wav"));
    symlinkSync("/tmp", join(ws, "samples", "escape"));
    const out = listSamples(ws, {});
    expect(out.ok && out.value.map((s) => [s.relPath, s.format, s.bytes])).toEqual([
      ["drums/snare.aif", "aif", 6],
      ["kick.wav", "wav", 8],
    ]);
  });

  it("filters by name query", () => {
    mkdirSync(join(ws, "samples"));
    writeFileSync(join(ws, "samples", "Kick Punchy.wav"), "x");
    writeFileSync(join(ws, "samples", "Snare.wav"), "x");
    const out = listSamples(ws, { query: "kick" });
    expect(out.ok && out.value.map((s) => s.name)).toEqual(["Kick Punchy"]);
  });

  it("returns an empty list when the samples folder doesn't exist yet", () => {
    expect(listSamples(ws, {})).toEqual({ ok: true, value: [] });
  });

  it("refuses a samples folder that is a symlink leading outside the workspace", () => {
    symlinkSync("/tmp", join(ws, "samples"));
    expect(listSamples(ws, {})).toEqual({ ok: false, error: "samples folder is a symlink; refusing to follow it outside the workspace" });
  });
});
