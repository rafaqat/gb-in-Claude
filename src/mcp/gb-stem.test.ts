// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGbStem } from "./gb-stem.js";
import { ok, err } from "../result.js";
import type { ModelSidecar } from "../models/sidecar.js";
import { bareWav } from "../band/testing.js";

/** A fake sidecar: records calls; answers like gbmodels/stems.py and writes the files it reports. */
function fakeSidecar(answer: (inputs: Record<string, unknown>) => Record<string, unknown>) {
  const calls: Record<string, unknown>[] = [];
  const sidecar: ModelSidecar = {
    async run(model, inputs) {
      calls.push({ model, ...inputs });
      return ok(answer(inputs));
    },
  } as ModelSidecar;
  return { sidecar, calls };
}

let ws: string;
beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), "gbstem-"))); // gb-mcp resolves the workspace to its real path
  writeFileSync(join(ws, "tabla.wav"), "RIFF");
});

const inspectAnswer = (inputs: Record<string, unknown>) => ({
  wav: inputs.wav, rate: 44100, subtype: "PCM_24", channels: 2, seconds: 4.0, bpm: 132.4, key: "E minor",
  key_confidence: 0.6, mode: "percussive", peak_dbfs: -1.5, placeable: true,
});

describe("gb_stem inspect", () => {
  it("reports a workspace file's format, tempo, key and whether gb_band can place it", async () => {
    const { sidecar, calls } = fakeSidecar(inspectAnswer);
    const r = await createGbStem({ workspaceDir: ws, models: sidecar })({ command: "inspect", path: "tabla.wav" });
    expect(r.status).toBe("verified");
    expect(r).toMatchObject({ data: { bpm: 132.4, key: "E minor", placeable: true } });
    expect(calls[0]).toMatchObject({ model: "stems", op: "inspect", wav: join(ws, "tabla.wav") });
  });
  it("refuses a path outside the workspace and never calls the sidecar", async () => {
    const { sidecar, calls } = fakeSidecar(inspectAnswer);
    const r = await createGbStem({ workspaceDir: ws, models: sidecar })({ command: "inspect", path: "../secret.wav" });
    expect(r.status).toBe("failed");
    expect(calls).toEqual([]);
  });
  it("without the model sidecar: DEPENDENCY_MISSING with the install hint", async () => {
    const r = await createGbStem({ workspaceDir: ws })({ command: "inspect", path: "tabla.wav" });
    expect(r).toMatchObject({ status: "failed", error: "DEPENDENCY_MISSING" });
  });
});

describe("gb_stem prepare", () => {
  const prepareAnswer = (expectedSeconds: number, measuredBpm: number | null) => (inputs: Record<string, unknown>) => {
    if (inputs.op === "prepare") {
      writeFileSync(inputs.out as string, bareWav(Math.round(expectedSeconds * 44100), 2, 44100, 24));
      return { out: inputs.out, mode: "percussive", from_bpm: 100, to_bpm: 132, factor: 100 / 132, semitones: 0, stretched: true, measured: false, rate: 44100, bits: 24, seconds: expectedSeconds };
    }
    return { ...inspectAnswer(inputs), seconds: expectedSeconds, bpm: measuredBpm };
  };
  it("writes stems/<filename>, then re-inspects it: verified when it is placeable and at the song tempo", async () => {
    const { sidecar, calls } = fakeSidecar(prepareAnswer(3.03, 131.9));
    const r = await createGbStem({ workspaceDir: ws, models: sidecar })({ command: "prepare", path: "tabla.wav", filename: "tabla-132.wav", to_bpm: 132, from_bpm: 100 });
    expect(r.status).toBe("verified");
    expect(calls.map((c) => c.op)).toEqual(["prepare", "inspect"]);
    expect(calls[0]).toMatchObject({ out: join(ws, "stems", "tabla-132.wav"), to_bpm: 132, from_bpm: 100 });
    expect(r).toMatchObject({ data: { path: join(ws, "stems", "tabla-132.wav"), measured_bpm: 131.9 } });
  });
  it("a measured tempo more than 2 % off the song tempo is a warning, not a pass in silence", async () => {
    const { sidecar } = fakeSidecar(prepareAnswer(3.03, 120));
    const r = await createGbStem({ workspaceDir: ws, models: sidecar })({ command: "prepare", path: "tabla.wav", filename: "t.wav", to_bpm: 132, from_bpm: 100 });
    expect(r.status).toBe("verified");
    expect((r as { warnings?: string[] }).warnings?.join(" ")).toContain("120");
  });
  it("never overwrites: an existing output is FILE_EXISTS and the sidecar is not called", async () => {
    mkdirSync(join(ws, "stems"));
    writeFileSync(join(ws, "stems", "t.wav"), "keep me");
    const { sidecar, calls } = fakeSidecar(prepareAnswer(3, 132));
    const r = await createGbStem({ workspaceDir: ws, models: sidecar })({ command: "prepare", path: "tabla.wav", filename: "t.wav", to_bpm: 132 });
    expect(r).toMatchObject({ status: "failed", error: "FILE_EXISTS" });
    expect(calls).toEqual([]);
  });
  it("dry_run plans without writing or calling the sidecar; a filename with a path is refused", async () => {
    const { sidecar, calls } = fakeSidecar(prepareAnswer(3, 132));
    const gb = createGbStem({ workspaceDir: ws, models: sidecar });
    const dry = await gb({ command: "prepare", path: "tabla.wav", filename: "t.wav", to_bpm: 132, dry_run: true });
    expect(dry).toMatchObject({ status: "verified", data: { dry_run: true, path: join(ws, "stems", "t.wav") } });
    expect(calls).toEqual([]);
    expect(existsSync(join(ws, "stems", "t.wav"))).toBe(false);
    expect((await gb({ command: "prepare", path: "tabla.wav", filename: "../t.wav", to_bpm: 132 })).status).toBe("failed");
  });
});

describe("gb_stem separate", () => {
  it("writes four stems into stems/ and verifies each is placeable (gb-mcp reads each header itself)", async () => {
    const { sidecar, calls } = fakeSidecar((inputs) => {
      if (inputs.op === "separate") {
        const dir = inputs.out_dir as string;
        mkdirSync(dir, { recursive: true });
        const stems = Object.fromEntries(["vocals", "drums", "bass", "other"].map((s) => [s, join(dir, `tabla-${s}.wav`)]));
        for (const p of Object.values(stems)) writeFileSync(p, bareWav(44100 * 4, 2, 44100, 24));
        return { stems, model: "htdemucs", rate: 44100 };
      }
      return inspectAnswer(inputs);
    });
    const r = await createGbStem({ workspaceDir: ws, models: sidecar })({ command: "separate", path: "tabla.wav" });
    expect(r.status).toBe("verified");
    expect(calls[0]).toMatchObject({ op: "separate", out_dir: join(ws, "stems") });
    expect(Object.keys((r as { data: { stems: object } }).data.stems).sort()).toEqual(["bass", "drums", "other", "vocals"]);
  });
  it("a sidecar error comes back as a failed result with its message", async () => {
    const sidecar = { async run() { return err({ code: "MODEL_FAILED", message: "FileExistsError: stems already exist: tabla-vocals.wav" }); } } as unknown as ModelSidecar;
    const r = await createGbStem({ workspaceDir: ws, models: sidecar })({ command: "separate", path: "tabla.wav" });
    expect(r.status).toBe("failed");
    expect(JSON.stringify(r)).toContain("already exist");
  });
});

describe("gb_stem verification reads the files itself", () => {
  it("a stem the sidecar wrote as float WAV is not placeable: the result fails, naming the file", async () => {
    const { sidecar } = fakeSidecar((inputs) => {
      const dir = inputs.out_dir as string;
      mkdirSync(dir, { recursive: true });
      const stems = Object.fromEntries(["vocals", "drums", "bass", "other"].map((s) => [s, join(dir, `tabla-${s}.wav`)]));
      for (const [name, p] of Object.entries(stems)) writeFileSync(p, name === "bass" ? bareWav(44100, 2, 44100, 32) : bareWav(44100, 2, 44100, 24));
      return { stems, model: "htdemucs", rate: 44100 };
    });
    const r = await createGbStem({ workspaceDir: ws, models: sidecar })({ command: "separate", path: "tabla.wav" });
    expect(r.status).toBe("failed");
    expect(JSON.stringify(r)).toContain("tabla-bass.wav");
  });
});

describe("gb_stem never writes through a link", () => {
  it("prepare: a dangling link at stems/<filename> is FILE_EXISTS and the sidecar is not called", async () => {
    mkdirSync(join(ws, "stems"));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "outside-")));
    symlinkSync(join(outside, "escaped.wav"), join(ws, "stems", "t.wav"));
    const { sidecar, calls } = fakeSidecar(inspectAnswer);
    const r = await createGbStem({ workspaceDir: ws, models: sidecar })({ command: "prepare", path: "tabla.wav", filename: "t.wav", to_bpm: 132 });
    expect(r).toMatchObject({ status: "failed", error: "FILE_EXISTS" });
    expect(calls).toEqual([]);
  });
  it("separate: a dangling link at a stem's name is FILE_EXISTS", async () => {
    mkdirSync(join(ws, "stems"));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "outside-")));
    symlinkSync(join(outside, "escaped.wav"), join(ws, "stems", "tabla-drums.wav"));
    const { sidecar, calls } = fakeSidecar(inspectAnswer);
    const r = await createGbStem({ workspaceDir: ws, models: sidecar })({ command: "separate", path: "tabla.wav" });
    expect(r).toMatchObject({ status: "failed", error: "FILE_EXISTS" });
    expect(calls).toEqual([]);
  });
});
