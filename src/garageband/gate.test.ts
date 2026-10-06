// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMutationGate } from "./gate.js";
import { verified } from "../mcp/envelope.js";

describe("mutation gate", () => {
  it("refuses a second GarageBand mutation while one is running, then frees up", async () => {
    const gate = createMutationGate();
    let release!: () => void;
    const first = gate.run("gb_export.song", () => new Promise((r) => { release = () => r(verified("gb_export.song", {})); }));
    expect(await gate.run("gb_project.open_midi", async () => verified("x", {}))).toMatchObject({
      status: "failed", error: "MUTATION_IN_PROGRESS", safe_to_retry: true,
    });
    release();
    expect(await first).toMatchObject({ status: "verified" });
    expect(await gate.run("gb_project.open_midi", async () => verified("gb_project.open_midi", {}))).toMatchObject({ status: "verified" });
  });

  it("frees the gate even when the operation throws", async () => {
    const gate = createMutationGate();
    await expect(gate.run("a", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await gate.run("b", async () => verified("b", {}))).toMatchObject({ status: "verified" });
  });
});

describe("cross-process lock", () => {
  const dir = () => realpathSync(mkdtempSync(join(tmpdir(), "gbmcp-lock-")));

  it("refuses while another live process holds the workspace lock", async () => {
    const lockPath = join(dir(), ".gb-mcp.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, op: "gb_export.song" })); // a live process
    const r = await createMutationGate({ lockPath }).run("gb_tracks.select", async () => ({ status: "verified", op: "x", data: {} }));
    expect(r).toMatchObject({ status: "failed", error: "MUTATION_IN_PROGRESS", safe_to_retry: true });
    expect(r.status === "failed" && r.message).toMatch(/another gb-mcp/);
  });

  it("takes over a stale lock (dead pid) and releases its own lock afterwards", async () => {
    const lockPath = join(dir(), ".gb-mcp.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: 999_999_999, op: "crashed" }));
    let held = false;
    const r = await createMutationGate({ lockPath }).run("x", async () => { held = existsSync(lockPath); return { status: "verified", op: "x", data: {} }; });
    expect(r.status).toBe("verified");
    expect(held).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  const ok = async () => ({ status: "verified" as const, op: "x", data: {} });

  // security review 2026-10-06 (B3): two processes that both judged a lock stale could both unlink-and-link, the second
  // deleting the first one's fresh lock. Only the holder of the takeover lock (an atomic mkdir) may remove a stale lock.
  it("never removes a stale lock while another process is taking it over", async () => {
    const lockPath = join(dir(), ".gb-mcp.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: 999_999, op: "dead" }));
    mkdirSync(`${lockPath}.takeover`); // another contender is mid-takeover (fresh)
    const r = await createMutationGate({ lockPath }).run("gb_tracks.select", async () => verified("x", {}));
    expect(r).toMatchObject({ status: "failed", error: "MUTATION_IN_PROGRESS", safe_to_retry: true });
    expect(JSON.parse(readFileSync(lockPath, "utf8")).op).toBe("dead"); // untouched: the other contender owns the takeover
  });

  it("an abandoned takeover lock (its owner died mid-takeover) does not block forever", async () => {
    const lockPath = join(dir(), ".gb-mcp.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: 999_999, op: "dead" }));
    mkdirSync(`${lockPath}.takeover`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${lockPath}.takeover`, old, old);
    const r = await createMutationGate({ lockPath }).run("gb_tracks.select", async () => verified("x", {}));
    expect(r).toMatchObject({ status: "verified" });
    expect(existsSync(`${lockPath}.takeover`)).toBe(false);
  });

  it("names the lock file in the refusal (so a human can inspect it)", async () => {
    const lockPath = join(dir(), ".gb-mcp.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, op: "gb_export.song" }));
    const r = await createMutationGate({ lockPath }).run("x", ok);
    expect(r.status === "failed" && JSON.stringify(r.context)).toContain(lockPath);
  });

  it("an unreadable lock that was just written counts as held (never stolen mid-write)", async () => {
    const lockPath = join(dir(), ".gb-mcp.lock");
    writeFileSync(lockPath, "");
    expect(await createMutationGate({ lockPath }).run("x", ok)).toMatchObject({ status: "failed", error: "MUTATION_IN_PROGRESS" });
  });

  it("a lock older than any GarageBand mutation is stale even if its pid was reused", async () => {
    const lockPath = join(dir(), ".gb-mcp.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, op: "ancient" }));
    const old = Date.now() / 1000 - 3600;
    utimesSync(lockPath, old, old);
    expect(await createMutationGate({ lockPath }).run("x", ok)).toMatchObject({ status: "verified" });
  });

  it("creates a missing lock directory, and an impossible lock path is a failed envelope, not a throw", async () => {
    const base = dir();
    expect(await createMutationGate({ lockPath: join(base, "deeper", "gb-mcp", "garageband.lock") }).run("x", ok)).toMatchObject({ status: "verified" });
    writeFileSync(join(base, "a-file"), "x");
    const r = await createMutationGate({ lockPath: join(base, "a-file", "garageband.lock") }).run("x", ok);
    expect(r).toMatchObject({ status: "failed", error: "WRITE_FAILED", write_attempted: false });
  });
});
