// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkspaceFile } from "./paths.js";

const AUDIO = [".wav", ".aif", ".aiff", ".flac"];
let ws: string;
let outside: string;

beforeAll(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), "gbmcp-ws-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "gbmcp-out-")));
  mkdirSync(join(ws, "exports"));
  writeFileSync(join(ws, "exports", "mix.wav"), "RIFF");
  writeFileSync(join(ws, "song.mp3"), "ID3");
  writeFileSync(join(outside, "secret.wav"), "RIFF");
  symlinkSync(join(outside, "secret.wav"), join(ws, "link.wav"));
});

describe("resolveWorkspaceFile", () => {
  it("accepts a relative path inside the workspace and returns the real absolute path", () => {
    expect(resolveWorkspaceFile(ws, "exports/mix.wav", AUDIO)).toEqual({ ok: true, value: join(ws, "exports", "mix.wav") });
  });

  it("accepts an absolute path inside the workspace", () => {
    expect(resolveWorkspaceFile(ws, join(ws, "exports", "mix.wav"), AUDIO).ok).toBe(true);
  });

  it.each([
    ["absolute path elsewhere", () => join(outside, "secret.wav")],
    ["../ traversal", () => "../" + "x.wav"],
    ["symlink escaping the workspace", () => "link.wav"],
  ])("refuses %s with PATH_OUTSIDE_WORKSPACE", (_label, input) => {
    const out = resolveWorkspaceFile(ws, input(), AUDIO);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("PATH_OUTSIDE_WORKSPACE");
  });

  it.each(["%2e%2e/x.wav", "exports/%2Fmix.wav", "mix.wav?x=1", "mix.wav#a", "mi\u0000x.wav", "line\nbreak.wav", ""])(
    "refuses hallucination-shaped input %j with PATH_INVALID",
    (input) => {
      const out = resolveWorkspaceFile(ws, input, AUDIO);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error.code).toBe("PATH_INVALID");
    },
  );

  it("reports a missing file inside the workspace as FILE_NOT_FOUND", () => {
    const out = resolveWorkspaceFile(ws, "exports/nope.wav", AUDIO);
    expect(!out.ok && out.error.code).toBe("FILE_NOT_FOUND");
  });

  it("reports a disallowed extension as NOT_SUPPORTED", () => {
    const out = resolveWorkspaceFile(ws, "song.mp3", AUDIO);
    expect(!out.ok && out.error.code).toBe("NOT_SUPPORTED");
  });
});
