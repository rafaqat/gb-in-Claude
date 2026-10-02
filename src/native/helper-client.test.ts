// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HelperClient } from "./helper-client.js";

const FAKE = fileURLToPath(new URL("./testing/fake-helper-process.mjs", import.meta.url));
const clients: HelperClient[] = [];
const client = (extra: Partial<ConstructorParameters<typeof HelperClient>[0]> = {}) => {
  const c = new HelperClient({ command: process.execPath, args: [FAKE], graceMs: 100, ...extra });
  clients.push(c);
  return c;
};
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

describe("HelperClient", () => {
  it("round-trips a request and returns the result", async () => {
    expect(await client().call("hello")).toMatchObject({ ok: true, value: { version: "fake", protocol: 1 } });
  });

  it("sends the deadline to the helper", async () => {
    expect(await client().call("deadline", {}, { deadlineMs: 1234 })).toEqual({ ok: true, value: { deadline_ms: 1234 } });
  });

  it("passes helper failures through as values", async () => {
    expect(await client().call("fail")).toEqual({ ok: false, error: { code: "TARGET_NOT_FOUND", message: "nothing there", details: { similar: [] } } });
  });

  it("serializes concurrent calls: one in flight, answers matched to their callers", async () => {
    const c = client();
    const order: string[] = [];
    const slow = c.call("sleep", { ms: 120 }).then((r) => { order.push("slow"); return r; });
    const fast = c.call("echo", { n: 2 }).then((r) => { order.push("fast"); return r; });
    expect(await slow).toEqual({ ok: true, value: { slept: 120 } });
    expect(await fast).toEqual({ ok: true, value: { n: 2 } });
    expect(order).toEqual(["slow", "fast"]);
  });

  it("a helper that outlives its deadline is killed (DEADLINE_EXCEEDED) and replaced on the next call", async () => {
    const c = client();
    const first = await c.call("count");
    expect(await c.call("sleep", { ms: 2_000 }, { deadlineMs: 50 })).toMatchObject({ ok: false, error: { code: "DEADLINE_EXCEEDED" } });
    const after = await c.call("count");
    expect(after).toMatchObject({ ok: true, value: { count: 1 } }); // fresh process
    expect(first.ok && after.ok && (first.value as { pid: number }).pid !== (after.value as { pid: number }).pid).toBe(true);
  });

  it("garbage on stdout is a protocol error; the stream is resynced with a fresh process", async () => {
    const c = client();
    expect(await c.call("garbage")).toMatchObject({ ok: false, error: { code: "HELPER_PROTOCOL_ERROR" } });
    expect(await c.call("echo", { ok: 1 })).toEqual({ ok: true, value: { ok: 1 } });
  });

  it("a crash during a MUTATING op is reported, never retried (it may already have happened)", async () => {
    const c = client();
    expect(await c.call("ax.press", { selector: {} })).toMatchObject({ ok: false, error: { code: "HELPER_UNAVAILABLE" } });
    expect(await c.call("echo", { again: true })).toEqual({ ok: true, value: { again: true } });
  });

  it("a crash during a READ-ONLY op is retried once on a fresh process", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "gbhelper-")), "crashed");
    const c = client({ env: { ...process.env, CRASH_MARKER: marker } });
    expect(await c.call("app.state")).toMatchObject({ ok: true, value: { running: true } });
  });

  it("a missing helper binary is HELPER_UNAVAILABLE with a build hint", async () => {
    const c = new HelperClient({ command: "/nonexistent/gb-helper" });
    clients.push(c);
    const r = await c.call("hello");
    expect(r).toMatchObject({ ok: false, error: { code: "HELPER_UNAVAILABLE" } });
    expect(!r.ok && r.error.message).toContain("build-helper.sh");
  });

  it("does not leak listeners: many calls on one process keep a constant listener count (live run found 11+)", async () => {
    const c = client();
    for (let i = 0; i < 15; i++) await c.call("echo", { i });
    const proc = (c as unknown as { proc: { listenerCount: (e: string) => number } }).proc;
    expect(proc.listenerCount("exit")).toBeLessThanOrEqual(1);
  });

  it("close() ends the helper process", async () => {
    const c = client();
    await c.call("hello");
    const pid = c.pid!;
    await c.close();
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
