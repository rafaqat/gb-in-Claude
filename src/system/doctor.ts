// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import type { HelperPort } from "../native/helper-port.js";
import { parseScreenLocked } from "../garageband/screen.js";
import { callOp, HelloResult, PermCheckResult, AppStateResult, type PermCheckResult as PermT, type AppStateResult as AppT } from "../native/protocol.js";

export type ExecResult = { ok: true; stdout: string; stderr: string } | { ok: false; error: string };

export type DoctorDeps = {
  helper: HelperPort;
  helperPath: string;
  workspaceDir: string;
  nodeVersion: string;
  supportedVersions: readonly string[];
  /** Run a program with an argv array (never a shell string) and a timeout. */
  exec: (file: string, args: string[], timeoutMs: number) => Promise<ExecResult>;
  fileInfo: (path: string) => { exists: boolean; executable: boolean };
  /** The directory (or, if it does not exist yet, its nearest existing parent) is writable. */
  dirWritable: (dir: string) => boolean;
  python?: string;
  ffmpeg?: string;
};

export type Severity = "required" | "recommended" | "info";
export type DoctorCheck = { name: string; ok: boolean; severity: Severity; detail: string; fix?: string };
export type DoctorReport = {
  ready: boolean;
  checks: DoctorCheck[];
  summary: { passed: number; failed_required: string[]; failed_recommended: string[] };
};

const HELPER_ID = "com.gbmcp.helper";
const AX_FIX = "System Settings ▸ Privacy & Security ▸ Accessibility: enable the app that runs Claude Code (e.g. Terminal), then restart it";
const AUTOMATION_FIX = "System Settings ▸ Privacy & Security ▸ Automation: allow the app that runs Claude Code to control GarageBand";
const SCREEN_FIX = "System Settings ▸ Privacy & Security ▸ Screen & System Audio Recording: enable the app that runs Claude Code (needed for screenshots only)";

/**
 * Environment checks for gb-mcp: native helper, macOS permissions (never prompts), GarageBand install/version/state,
 * the analysis toolchain, workspace and Node. `ready` = every REQUIRED check passed.
 */
export async function runDoctor(d: DoctorDeps): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const add = (c: DoctorCheck) => checks.push(c);

  const nodeMajor = Number(d.nodeVersion.split(".")[0]);
  add({ name: "node.version", ok: nodeMajor >= 20, severity: "required", detail: `Node ${d.nodeVersion}`, ...(nodeMajor >= 20 ? {} : { fix: "install Node 20 or newer" }) });

  const writable = d.dirWritable(d.workspaceDir);
  add({ name: "workspace.writable", ok: writable, severity: "required", detail: d.workspaceDir, ...(writable ? {} : { fix: "set GB_MCP_WORKSPACE to a writable folder" }) });

  // --- native helper
  const bin = d.fileInfo(d.helperPath);
  add({
    name: "helper.binary", ok: bin.exists && bin.executable, severity: "required",
    detail: bin.exists ? (bin.executable ? d.helperPath : `${d.helperPath} is not executable`) : `${d.helperPath} not found`,
    ...(bin.exists && bin.executable ? {} : { fix: "build it: gb-mcp/native/build-helper.sh" }),
  });

  const sig = bin.exists ? await d.exec("codesign", ["--display", "--verbose=1", d.helperPath], 5_000) : { ok: false as const, error: "binary missing" };
  const sigText = sig.ok ? `${sig.stdout}\n${sig.stderr}` : "";
  const identifier = /Identifier=(\S+)/.exec(sigText)?.[1];
  const signature = /Signature=(\S+)/.exec(sigText)?.[1];
  const signedOk = identifier === HELPER_ID;
  add({
    name: "helper.signature", ok: signedOk, severity: "recommended",
    detail: sig.ok ? `identifier ${identifier ?? "none"}, signature ${signature ?? "none"}` : `not checked (${sig.error})`,
    ...(signedOk ? {} : { fix: "rebuild with gb-mcp/native/build-helper.sh (ad-hoc signs as com.gbmcp.helper)" }),
  });

  const hello = await callOp(d.helper, "hello", {}, HelloResult, { deadlineMs: 3_000 });
  add({
    name: "helper.handshake", ok: hello.ok && hello.value.protocol === 1, severity: "required",
    detail: hello.ok ? `gb-helper ${hello.value.version}, protocol ${hello.value.protocol}, pid ${hello.value.pid}` : `${hello.error.code}: ${hello.error.message}`,
    ...(hello.ok ? {} : { fix: "build it: gb-mcp/native/build-helper.sh" }),
  });

  // --- permissions & GarageBand (need the helper)
  const unavailable = (name: string, severity: Severity): DoctorCheck => ({ name, ok: false, severity, detail: "not checked: helper unavailable" });
  let perm: PermT | undefined;
  let app: AppT | undefined;
  if (hello.ok) {
    const p = await callOp(d.helper, "perm.check", {}, PermCheckResult, { deadlineMs: 5_000 });
    if (p.ok) perm = p.value;
    const a = await callOp(d.helper, "app.state", {}, AppStateResult, { deadlineMs: 5_000 });
    if (a.ok) app = a.value;
  }

  if (perm) {
    add({ name: "permission.accessibility", ok: perm.accessibility, severity: "required", detail: perm.accessibility ? "granted" : "not granted", ...(perm.accessibility ? {} : { fix: AX_FIX }) });
    const gb = perm.automation.garageband;
    add({
      name: "permission.automation.garageband", ok: gb === "granted", severity: "recommended",
      detail: gb === "not_running" ? "undetermined (GarageBand not running)" : gb,
      ...(gb === "granted" ? {} : { fix: gb === "denied" ? AUTOMATION_FIX : "will be asked on first project open/save; or: " + AUTOMATION_FIX }),
    });
    const se = perm.automation.system_events;
    add({
      name: "permission.automation.system_events", ok: se === "granted" || se === "not_running", severity: "info",
      detail: se === "not_running" ? "System Events not running (decided on first use)" : se,
      ...(se === "denied" ? { fix: AUTOMATION_FIX.replace("GarageBand", "System Events") } : {}),
    });
    add({ name: "permission.screen_recording", ok: perm.screen_recording, severity: "recommended", detail: perm.screen_recording ? "granted" : "not granted", ...(perm.screen_recording ? {} : { fix: SCREEN_FIX }) });
  } else {
    for (const [n, s] of [["permission.accessibility", "required"], ["permission.automation.garageband", "recommended"], ["permission.automation.system_events", "info"], ["permission.screen_recording", "recommended"]] as const) add(unavailable(n, s));
  }

  if (app) {
    const v = app.installed?.version ?? null;
    add({
      name: "garageband.installed", ok: app.installed !== null, severity: "required",
      detail: app.installed ? `GarageBand ${v ?? "?"} (build ${app.installed.build ?? "?"}) at ${app.installed.path}` : "GarageBand is not installed",
      ...(app.installed ? {} : { fix: "install GarageBand from the App Store" }),
    });
    const supported = v !== null && d.supportedVersions.includes(v);
    add({
      name: "garageband.version_supported", ok: supported, severity: "required",
      detail: supported ? `${v} has a verified locator set` : `installed ${v ?? "none"}; locators exist for ${d.supportedVersions.join(", ")}`,
      ...(supported ? {} : { fix: "UI locators are version-specific: run the probe kit against this version before mutating GarageBand" }),
    });
    add({
      name: "garageband.running", ok: app.running, severity: "info",
      detail: app.running ? `running (pid ${app.pid}${app.frontmost ? ", frontmost" : ""}; ${app.windows?.length ?? 0} window(s), ${app.dialog_count ?? 0} dialog(s))` : "not running",
      ...(app.running ? {} : { fix: "open GarageBand (e.g. open -a GarageBand <rendered.mid>)" }),
    });
  } else {
    for (const [n, s] of [["garageband.installed", "required"], ["garageband.version_supported", "required"], ["garageband.running", "info"]] as const) add(unavailable(n, s));
  }

  // --- analysis toolchain (gb_analyze)
  const py = await d.exec(d.python ?? "python3", ["-c",
    "import json, numpy, scipy, soundfile, matplotlib; print(json.dumps({'numpy': numpy.__version__, 'scipy': scipy.__version__, 'soundfile': soundfile.__version__, 'matplotlib': matplotlib.__version__}))",
  ], 30_000);
  let pyDetail = py.ok ? "" : `unavailable (${py.error})`;
  let pyOk = false;
  if (py.ok) {
    try {
      const v = JSON.parse(py.stdout.trim()) as Record<string, string>;
      pyDetail = Object.entries(v).map(([k, ver]) => `${k} ${ver}`).join(", ");
      pyOk = true;
    } catch {
      pyDetail = "unexpected output from python3";
    }
  }
  // A locked screen leaves GarageBand without usable windows.
  const ioreg = await d.exec("ioreg", ["-n", "Root", "-d1", "-a"], 5_000);
  const locked = ioreg.ok && parseScreenLocked(ioreg.stdout);
  add({
    name: "session.screen_unlocked", ok: !locked, severity: "recommended",
    detail: !ioreg.ok ? "could not read the session lock state" : locked ? "the screen is locked: GarageBand has no usable windows" : "unlocked",
    ...(locked ? { fix: "Unlock the Mac, then retry GarageBand operations (analysis and composition still work)" } : {}),
  });

  add({ name: "analysis.python", ok: pyOk, severity: "recommended", detail: pyDetail, ...(pyOk ? {} : { fix: "python3 with numpy, scipy, soundfile and matplotlib is needed for gb_analyze" }) });

  const ff = await d.exec(d.ffmpeg ?? "ffmpeg", ["-hide_banner", "-filters"], 15_000);
  const ffOk = ff.ok && /\bebur128\b/.test(ff.stdout);
  add({
    name: "analysis.ffmpeg", ok: ffOk, severity: "recommended",
    detail: ff.ok ? (ffOk ? "ffmpeg with ebur128 (EBU R128 loudness reference)" : "ffmpeg found but without the ebur128 filter") : `unavailable (${ff.error})`,
    ...(ffOk ? {} : { fix: "install ffmpeg (e.g. brew install ffmpeg) — used to cross-check loudness" }),
  });

  const failedRequired = checks.filter((c) => !c.ok && c.severity === "required").map((c) => c.name);
  const failedRecommended = checks.filter((c) => !c.ok && c.severity === "recommended").map((c) => c.name);
  return {
    ready: failedRequired.length === 0,
    checks,
    summary: { passed: checks.filter((c) => c.ok).length, failed_required: failedRequired, failed_recommended: failedRecommended },
  };
}
