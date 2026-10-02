// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { runDoctor, type DoctorDeps, type ExecResult } from "./doctor.js";
import { FakeHelper } from "../ax/fake-helper.js";

const execOk = (stdout = "", stderr = ""): ExecResult => ({ ok: true, stdout, stderr });

function deps(over: Partial<DoctorDeps> = {}, helper = new FakeHelper()): DoctorDeps {
  return {
    helper,
    helperPath: "/gb-mcp/native/bin/gb-helper",
    workspaceDir: "/garageband/out",
    nodeVersion: "24.13.0",
    supportedVersions: ["10.4.14"],
    fileInfo: () => ({ exists: true, executable: true }),
    dirWritable: () => true,
    exec: async (file, args) => {
      if (file === "codesign") return execOk("", "Identifier=com.gbmcp.helper\nSignature=adhoc\n");
      if (file === "python3") return execOk(JSON.stringify({ numpy: "2.5.3", scipy: "1.18.1", soundfile: "0.13.1", matplotlib: "3.10.8" }));
      if (file === "ffmpeg" && args.includes("-filters")) return execOk(" .. ebur128           A->N       EBU R128 scanner.\n");
      if (file === "ioreg") return execOk("<plist><dict><key>CGSSessionScreenIsLocked</key><false/></dict></plist>");
      return { ok: false, error: `unexpected ${file}` };
    },
    ...over,
  };
}

const check = (r: Awaited<ReturnType<typeof runDoctor>>, name: string) => r.checks.find((c) => c.name === name)!;

describe("runDoctor", () => {
  it("a healthy setup is ready, with every check named", async () => {
    const r = await runDoctor(deps());
    expect(r.ready).toBe(true);
    expect(r.checks.map((c) => c.name)).toEqual([
      "node.version", "workspace.writable", "helper.binary", "helper.signature", "helper.handshake",
      "permission.accessibility", "permission.automation.garageband", "permission.automation.system_events", "permission.screen_recording",
      "garageband.installed", "garageband.version_supported", "garageband.running", "session.screen_unlocked",
      "analysis.python", "analysis.ffmpeg",
    ]);
    expect(check(r, "garageband.installed").detail).toContain("10.4.14");
    expect(check(r, "helper.signature").detail).toContain("com.gbmcp.helper");
  });

  it("a missing helper fails the helper checks with a build fix, and dependent checks say why they could not run", async () => {
    const helper = new FakeHelper();
    helper.failNext("hello", { code: "HELPER_UNAVAILABLE", message: "spawn ENOENT" });
    const r = await runDoctor(deps({ fileInfo: () => ({ exists: false, executable: false }) }, helper));
    expect(r.ready).toBe(false);
    expect(check(r, "helper.binary")).toMatchObject({ ok: false, severity: "required" });
    expect(check(r, "helper.binary").fix).toContain("build-helper.sh");
    expect(check(r, "permission.accessibility")).toMatchObject({ ok: false });
    expect(check(r, "permission.accessibility").detail).toContain("helper unavailable");
    expect(r.summary.failed_required).toContain("helper.handshake");
  });

  it("Accessibility not granted is a required failure with the exact settings path", async () => {
    const helper = new FakeHelper();
    helper.app.axTrusted = false;
    const r = await runDoctor(deps({}, helper));
    expect(r.ready).toBe(false);
    expect(check(r, "permission.accessibility").fix).toMatch(/Privacy & Security ▸ Accessibility/);
  });

  it("a locked screen is flagged: GarageBand has no usable windows until the Mac is unlocked", async () => {
    const base = deps();
    const locked = await runDoctor({ ...base, exec: async (file, args, t) =>
      file === "ioreg" ? execOk("<plist><dict><key>CGSSessionScreenIsLocked</key><true/></dict></plist>") : base.exec(file, args, t) });
    expect(check(locked, "session.screen_unlocked")).toMatchObject({ ok: false, severity: "recommended" });
    expect(check(locked, "session.screen_unlocked").fix).toMatch(/unlock/i);
  });

  it("an unsupported GarageBand version is a required failure (locators may not match)", async () => {
    const helper = new FakeHelper();
    helper.app.installed = { path: "/Applications/GarageBand.app", version: "10.4.15", build: "7000" };
    const r = await runDoctor(deps({}, helper));
    expect(check(r, "garageband.version_supported")).toMatchObject({ ok: false, severity: "required" });
    expect(check(r, "garageband.version_supported").detail).toContain("10.4.14");
  });

  it("GarageBand not installed / not running", async () => {
    const helper = new FakeHelper();
    helper.app.installed = null;
    helper.app.running = false;
    const r = await runDoctor(deps({}, helper));
    expect(check(r, "garageband.installed")).toMatchObject({ ok: false, severity: "required" });
    expect(check(r, "garageband.running")).toMatchObject({ ok: false, severity: "info" });
  });

  it("missing analysis tools are recommended failures (gb_analyze only), not blockers", async () => {
    const r = await runDoctor(deps({ exec: async () => ({ ok: false, error: "spawn python3 ENOENT" }) }));
    expect(check(r, "analysis.python")).toMatchObject({ ok: false, severity: "recommended" });
    expect(check(r, "analysis.ffmpeg")).toMatchObject({ ok: false, severity: "recommended" });
    expect(r.summary.failed_recommended).toEqual(expect.arrayContaining(["analysis.python", "analysis.ffmpeg", "helper.signature"]));
  });

  it("ffmpeg without the ebur128 loudness meter is flagged", async () => {
    const base = deps();
    const r = await runDoctor({ ...base, exec: async (f, a) => (f === "ffmpeg" ? execOk("no loudness filters here") : base.exec(f, a, 1)) });
    expect(check(r, "analysis.ffmpeg")).toMatchObject({ ok: false });
  });

  it("an unwritable workspace and an old Node are required failures", async () => {
    const r = await runDoctor(deps({ dirWritable: () => false, nodeVersion: "18.19.0" }));
    expect(check(r, "workspace.writable")).toMatchObject({ ok: false, severity: "required" });
    expect(check(r, "node.version")).toMatchObject({ ok: false, severity: "required" });
    expect(r.ready).toBe(false);
  });

  it("automation not yet determined is not a failure for System Events when it is simply not running", async () => {
    const r = await runDoctor(deps());
    expect(check(r, "permission.automation.system_events")).toMatchObject({ ok: true, severity: "info" });
  });
});
