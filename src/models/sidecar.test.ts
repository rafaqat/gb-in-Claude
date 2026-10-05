// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { createModelSidecar, type ModelSidecar } from "./sidecar.js";

const FAKE = fileURLToPath(new URL("./testing/fake-sidecar.mjs", import.meta.url));
let sidecar: ModelSidecar | undefined;
const make = (timeoutMs = 2000) => (sidecar = createModelSidecar({ command: process.execPath, args: [FAKE], cwd: process.cwd(), timeoutMs }));
afterEach(() => sidecar?.close());

describe("model sidecar client (M8): one long-lived process, JSON lines", () => {
  it("starts on the first request and answers it", async () => {
    const r = await make().run("echo", { wav: "a.wav" });
    expect(r).toMatchObject({ ok: true, value: { inputs: { wav: "a.wav" } } });
  });

  it("keeps the process warm: two requests, one process", async () => {
    const s = make();
    const a = await s.run("echo", {});
    const b = await s.run("echo", {});
    expect(a.ok && b.ok && (a.value as { pid: number }).pid === (b.value as { pid: number }).pid).toBe(true);
  });

  it("passes a model's failure through as a typed error, and keeps working", async () => {
    const s = make();
    expect(await s.run("nope", {})).toMatchObject({ ok: false, error: { code: "MODEL_FAILED" } });
    expect(await s.run("echo", {})).toMatchObject({ ok: true });
  });

  it("times a request out (SIDECAR_TIMEOUT) instead of waiting for ever", async () => {
    expect(await make(150).run("slow", {})).toMatchObject({ ok: false, error: { code: "SIDECAR_TIMEOUT" } });
  });

  it("reports a crash (SIDECAR_CRASHED), then starts a new process on the next request", async () => {
    const s = make();
    const first = await s.run("echo", {});
    expect(await s.run("crash", {})).toMatchObject({ ok: false, error: { code: "SIDECAR_CRASHED" } });
    const again = await s.run("echo", {});
    expect(again.ok).toBe(true);
    expect((again as { value: { pid: number } }).value.pid).not.toBe((first as { value: { pid: number } }).value.pid);
  });

  it("starts the process with extra environment variables (M12b: GBMODELS_ENV names an engine's environment)", async () => {
    sidecar = createModelSidecar({ command: process.execPath, args: [FAKE], cwd: process.cwd(), timeoutMs: 2000, env: { GBMODELS_ENV: "mulacover" } });
    expect(await sidecar.run("env", {})).toMatchObject({ ok: true, value: { GBMODELS_ENV: "mulacover" } });
    expect(await make().run("env", {})).toMatchObject({ ok: true, value: { GBMODELS_ENV: null } });
  });

  it("reports a sidecar that cannot start (SIDECAR_UNAVAILABLE)", async () => {
    sidecar = createModelSidecar({ command: "/nonexistent/python", args: [], cwd: process.cwd(), timeoutMs: 1000 });
    expect(await sidecar.run("echo", {})).toMatchObject({ ok: false, error: { code: "SIDECAR_UNAVAILABLE" } });
  });
});
