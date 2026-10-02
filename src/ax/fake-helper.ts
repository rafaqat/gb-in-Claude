// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ok, err, type Result } from "../result.js";
import type { CallOptions, HelperFailure, HelperPort } from "../native/helper-port.js";
import { findAll, parseSelector, type Selector, type TreeNode } from "./selector.js";
import { PROJECT_CHOOSER_ID } from "./locators.js";

/**
 * FakeAX — a HelperPort that behaves like gb-helper against GarageBand 10.4.14, built from the recorded
 * fixtures plus simulated semantics (checkbox toggles, ONE step per slider set, ", mute" description suffix,
 * Share ▸ Export opening the save panel). Op semantics and error codes mirror the Swift Dispatcher so that
 * everything above the HelperPort is testable without GarageBand. Time is virtual: sleeps advance `clockMs`.
 */
export type FakeApp = {
  running: boolean;
  axTrusted: boolean;
  frontmost: boolean;
  installed: { path: string; version: string | null; build: string | null } | null;
  permissions: { automation: { system_events: string; garageband: string }; screen_recording: boolean };
  windows: TreeNode[];
  menubar: TreeNode;
};

type Behavior = {
  onPress?: (node: TreeNode) => void;
  onSet?: (node: TreeNode, value: unknown) => void;
  /** A real click on this node (default for nodes with `selected`: select it, deselect its same-role siblings). */
  onClick?: (node: TreeNode) => void;
  onAction?: (node: TreeNode, action: string) => void;
};
type Deadline = { expired: () => boolean; remainingMs: () => number };
class HelperError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

const DIALOG_PRUNE = new Set(["AXOutline", "AXBrowser"]);

const NOISE_ACTIONS = new Set(["AXShowMenu", "AXScrollToVisible"]);

export class FakeHelper implements HelperPort {
  clockMs = 0;
  readonly calls: { op: string; params: Record<string, unknown> }[] = [];
  /** Runs after a target is resolved and before it is acted on — mutate the tree here to simulate drift. */
  beforeAction?: () => void;
  /** Simulates something on top of every click target (a popover, notification): clicks fail HIT_TEST_MISMATCH. */
  coveredBy?: TreeNode;
  /** false = macOS refuses to bring GarageBand forward. */
  activationWorks = true;
  /** false = the user's previous app cannot be brought back (restore_focus reports restored: false). */
  restoreWorks = true;
  /** The user keeps typing / pointing: activation never finds a pause (USER_INPUT_ACTIVE). */
  userTyping = false;
  /** A mouse button is held: clicks are refused (USER_INPUT_ACTIVE). */
  mouseButtonDown = false;
  /** Elements belonging to another app (system-wide hit test): described by role only. */
  readonly foreign = new WeakSet<TreeNode>();
  /** Real clicks delivered, in order (the node that received each). */
  readonly clicks: TreeNode[] = [];
  private activatedByUs = false;
  private readonly behaviors = new WeakMap<TreeNode, Behavior>();
  private readonly scheduled: { atMs: number; change: () => void }[] = [];
  private readonly faults = new Map<string, HelperFailure[]>();

  constructor(readonly app: FakeApp = garageBandFixtureApp()) {
    installGarageBandBehaviors(this);
  }

  on(node: TreeNode, behavior: Behavior): void {
    this.behaviors.set(node, { ...this.behaviors.get(node), ...behavior });
  }

  schedule(atMs: number, change: () => void): void {
    this.scheduled.push({ atMs, change });
  }

  failNext(op: string, failure: HelperFailure): void {
    this.faults.set(op, [...(this.faults.get(op) ?? []), failure]);
  }

  sleep(ms: number): void {
    this.clockMs += ms;
    const due = this.scheduled.filter((s) => s.atMs <= this.clockMs);
    for (const s of due) this.scheduled.splice(this.scheduled.indexOf(s), 1);
    due.forEach((s) => s.change());
  }

  async close(): Promise<void> {}

  async call(op: string, params: Record<string, unknown> = {}, opts: CallOptions = {}): Promise<Result<unknown, HelperFailure>> {
    this.calls.push({ op, params });
    const queued = this.faults.get(op);
    if (queued && queued.length > 0) return err(queued.shift()!);
    const start = this.clockMs;
    const budget = Math.min(Math.max(opts.deadlineMs ?? 2_000, 1), 120_000);
    const deadline: Deadline = { expired: () => this.clockMs - start >= budget, remainingMs: () => Math.max(0, budget - (this.clockMs - start)) };
    try {
      return ok(this.run(op, params, deadline));
    } catch (e) {
      if (e instanceof HelperError) return err({ code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) });
      return err({ code: "HELPER_INTERNAL", message: String(e) });
    }
  }

  // ---------------------------------------------------------------------------------------------------------------

  private run(op: string, p: Record<string, unknown>, d: Deadline): unknown {
    switch (op) {
      case "hello":
        return { version: "0.1.0-fake", protocol: 1, pid: 4242, ax_trusted: this.app.axTrusted };
      case "perm.check":
        return { accessibility: this.app.axTrusted, ...this.app.permissions };
      case "app.state":
        return this.appState();
      case "ax.find":
        return this.find(p, d);
      case "ax.press":
        return this.press(p, d);
      case "ax.set":
        return this.set(p, d);
      case "ax.converge":
        return this.converge(p, d);
      case "ax.menu":
        return this.menu(p);
      case "ax.wait":
        return this.wait(p, d);
      case "ax.snapshot":
        return this.snapshot(p, d);
      case "app.activate":
        return this.activate(d);
      case "app.restore_focus":
        return this.restoreFocus();
      case "ax.click":
        return this.click(p, d);
      case "ax.perform":
        return this.perform(p, d);
      default:
        throw new HelperError("UNKNOWN_OP", `unknown op "${op}"`);
    }
  }

  private appState() {
    const base = { bundle_id: "com.apple.garageband10", ax_trusted: this.app.axTrusted, installed: this.app.installed };
    if (!this.app.running) return { ...base, running: false };
    return {
      ...base, running: true, pid: 4243, frontmost: this.app.frontmost, hidden: false,
      windows: this.app.windows.map((w) => pick(w, ["role", "subrole", "title", "id"])),
      dialog_count: this.dialogs().length,
      sheet_count: this.app.windows.flatMap((w) => (w.children ?? []).filter((c) => c.role === "AXSheet")).length,
    };
  }

  private requireAX(): void {
    if (!this.app.axTrusted) throw new HelperError("PERMISSION_AX_DENIED", "Accessibility permission is not granted");
    if (!this.app.running) throw new HelperError("GB_NOT_RUNNING", "GarageBand is not running");
  }

  private dialogs(): TreeNode[] {
    return this.app.windows.filter((w) => w.subrole === "AXDialog" || w.subrole === "AXSystemDialog");
  }

  private resolveRoot(rootParam: unknown, d: Deadline): { node: TreeNode; prune: Set<string> } {
    const root = (rootParam ?? {}) as { kind?: string; title?: string; identifier?: string; element?: unknown };
    const one = (found: TreeNode[], what: string): TreeNode => {
      if (found.length === 1) return found[0]!;
      throw new HelperError(found.length === 0 ? "TARGET_NOT_FOUND" : "TARGET_AMBIGUOUS", `${found.length} ${what}`, { root: what, count: found.length });
    };
    let base: TreeNode;
    let prune = new Set<string>();
    switch (root.kind) {
      case "app":
        base = { role: "AXApplication", children: this.app.windows };
        break;
      case "main_window":
        // The project chooser is also a standard window: never the project.
        base = one(this.app.windows.filter((w) => w.subrole === "AXStandardWindow" && w.id !== PROJECT_CHOOSER_ID), "main window");
        break;
      case "dialog":
        base = one(this.dialogs().filter((w) => (root.title === undefined || w.title === root.title) && (root.identifier === undefined || w.id === root.identifier)), "dialog");
        prune = DIALOG_PRUNE;
        break;
      case "sheet":
        base = one(this.app.windows.flatMap((w) => (w.children ?? []).filter((c) => c.role === "AXSheet")), "sheet");
        break;
      case "menubar":
        base = this.app.menubar;
        break;
      case "window":
        if (root.title === undefined) throw new HelperError("INPUT_INVALID", "window root needs an exact title");
        base = one(this.app.windows.filter((w) => w.title === root.title), `window titled ${root.title}`);
        break;
      default:
        throw new HelperError("INPUT_INVALID", `unknown root kind "${root.kind}"`);
    }
    if (root.element === undefined) return { node: base, prune };
    const sel = this.selector(root.element);
    const found = findAll(base, sel, { pruneRoles: prune });
    if (d.expired()) throw new HelperError("DEADLINE_EXCEEDED", "root element search did not finish within the deadline");
    if (found.matches.length !== 1) {
      throw new HelperError(found.matches.length === 0 ? "TARGET_NOT_FOUND" : "TARGET_AMBIGUOUS", `root element: ${found.matches.length} matches (need exactly one)`, {
        count: found.matches.length, candidates: found.matches.slice(0, 6).map((m) => compact(m.node, m.path)),
      });
    }
    return { node: found.matches[0]!.node, prune };
  }

  private selector(input: unknown): Selector {
    const r = parseSelector(input);
    if (!r.ok) throw new HelperError("INPUT_INVALID", r.error);
    return r.value;
  }

  private options(p: Record<string, unknown>, prune: Set<string>, depth: number, nodes: number) {
    return {
      maxDepth: Math.min(Math.max(num(p.depth) ?? depth, 1), 32),
      maxNodes: Math.min(Math.max(num(p.max_nodes) ?? nodes, 1), 50_000),
      pruneRoles: Array.isArray(p.prune_roles) ? new Set(p.prune_roles.filter((r): r is string => typeof r === "string")) : prune,
    };
  }

  private find(p: Record<string, unknown>, d: Deadline) {
    this.requireAX();
    if (p.selector === undefined) throw new HelperError("INPUT_INVALID", "selector is required");
    const sel = this.selector(p.selector);
    const { node, prune } = this.resolveRoot(p.root, d);
    const found = findAll(node, sel, this.options(p, prune, 24, 20_000));
    const maxResults = Math.min(Math.max(num(p.max_results) ?? 20, 1), 200);
    return { count: found.matches.length, matches: found.matches.slice(0, maxResults).map((m) => compact(m.node, m.path)), truncated: found.truncated, visited: found.visited };
  }

  private resolveOne(p: Record<string, unknown>, d: Deadline): { node: TreeNode; path: string } {
    this.requireAX();
    if (p.selector === undefined) throw new HelperError("INPUT_INVALID", "selector is required");
    const sel = this.selector(p.selector);
    const { node: root, prune } = this.resolveRoot(p.root, d);
    const opts = this.options(p, prune, 24, 20_000);
    const found = findAll(root, sel, opts);
    if (found.matches.length === 1) {
      const m = found.matches[0]!;
      this.beforeAction?.();
      verifyIdentity(m.node, m.path, p.expect);
      return { node: m.node, path: m.path };
    }
    if (found.matches.length === 0) {
      const similar = sel.role !== undefined ? findAll(root, { role: sel.role }, opts).matches.slice(0, 8).map((m) => compact(m.node, m.path)) : [];
      throw new HelperError("TARGET_NOT_FOUND", "no element matches the selector", { similar });
    }
    throw new HelperError("TARGET_AMBIGUOUS", `${found.matches.length} elements match; refine the selector (ancestors/identifier/index)`, {
      count: found.matches.length, candidates: found.matches.slice(0, 6).map((m) => compact(m.node, m.path)),
    });
  }

  private settle(p: Record<string, unknown>, def: number): void {
    this.sleep(Math.min(Math.max(num(p.settle_ms) ?? def, 0), 2_000));
  }

  private press(p: Record<string, unknown>, d: Deadline) {
    const { node, path } = this.resolveOne(p, d);
    if (node.enabled === false) throw new HelperError("TARGET_DISABLED", "the target is disabled; pressing it would do nothing");
    if (!(node.actions ?? []).includes("AXPress")) throw new HelperError("NOT_SUPPORTED", "the target has no AXPress action");
    const before = compact(node, path);
    this.pressNode(node);
    this.settle(p, 150);
    return { before, after: this.isAttached(node) ? compact(node, path) : null };
  }

  private pressNode(node: TreeNode): void {
    const b = this.behaviors.get(node);
    if (b?.onPress) return b.onPress(node);
    if (node.role === "AXCheckBox") node.value = node.value === 1 ? 0 : 1;
  }

  private isAttached(node: TreeNode): boolean {
    const roots: TreeNode[] = [...this.app.windows, this.app.menubar];
    return roots.some((r) => contains(r, node));
  }

  private set(p: Record<string, unknown>, d: Deadline) {
    if (p.value === undefined || p.value === null) throw new HelperError("INPUT_INVALID", "value is required");
    const { node } = this.resolveOne(p, d);
    if (node.settable !== true) throw new HelperError("NOT_SETTABLE", "the target's value is not settable");
    const before = node.value ?? null;
    this.setNode(node, p.value);
    this.settle(p, 150);
    return { before, after: node.value ?? null, requested: p.value };
  }

  private setNode(node: TreeNode, value: unknown): void {
    const b = this.behaviors.get(node);
    if (b?.onSet) return b.onSet(node, value);
    if (node.role === "AXSlider" && typeof node.value === "number" && typeof value === "number" && isStepwise(node)) {
      node.value = node.value < value ? node.value + 1 : node.value > value ? node.value - 1 : node.value; // one step per set
    } else {
      node.value = value;
    }
  }

  private converge(p: Record<string, unknown>, d: Deadline) {
    const target = num(p.target);
    if (target === undefined) throw new HelperError("INPUT_INVALID", "target must be a number");
    const { node } = this.resolveOne(p, d);
    if (node.settable !== true) throw new HelperError("NOT_SETTABLE", "the target's value is not settable");
    const tolerance = Math.max(0, num(p.tolerance) ?? 0);
    const settleMs = Math.min(Math.max(num(p.settle_ms) ?? 120, 0), 2_000);
    const read = () => (typeof node.value === "number" ? node.value : undefined);
    const before = read();
    const result = { converged: false, steps: 0, target, stuck: false, deadline_exceeded: false, before: before ?? null, after: before ?? null };
    if (before === undefined) return result;
    if (Math.abs(before - target) <= tolerance) return { ...result, converged: true };
    const budget = num(p.max_steps) ?? Math.min(Math.ceil(Math.abs(target - before)) + 2, 1_000);
    let unchanged = 0;
    let last = before;
    while (result.steps < budget) {
      if (d.expired()) return { ...result, deadline_exceeded: true };
      this.setNode(node, target);
      result.steps++;
      this.sleep(settleMs);
      const v = read();
      if (v === undefined) return result;
      result.after = v;
      if (Math.abs(v - target) <= tolerance) return { ...result, converged: true };
      unchanged = v === last ? unchanged + 1 : 0;
      if (unchanged >= 3) return { ...result, stuck: true };
      last = v;
    }
    return result;
  }

  private activate(d: Deadline) {
    this.requireAX();
    if (this.app.frontmost) return { frontmost: true, changed: false };
    if (this.app.permissions.automation.garageband !== "granted") {
      throw new HelperError("PERMISSION_AUTOMATION_DENIED", "bringing GarageBand forward needs the Automation permission for GarageBand (never prompted here)");
    }
    if (this.userTyping) {
      this.sleep(Math.max(0, d.remainingMs() - 1_500));
      throw new HelperError("USER_INPUT_ACTIVE", "you are typing or using the pointer; GarageBand was not brought forward (your keys would land in it)");
    }
    if (!this.activationWorks) {
      this.sleep(Math.min(d.remainingMs(), 2_000));
      throw new HelperError("NOT_FRONTMOST", "GarageBand could not be brought to the front (macOS refused activation)");
    }
    this.app.frontmost = true;
    this.activatedByUs = true;
    return { frontmost: true, changed: true };
  }

  private restoreFocus() {
    const restored = this.restoreWorks && this.activatedByUs && this.app.frontmost;
    if (restored) this.app.frontmost = false;
    this.activatedByUs = false;
    return { restored };
  }

  private click(p: Record<string, unknown>, d: Deadline) {
    const { node, path } = this.resolveOne(p, d);
    if (!this.app.frontmost) throw new HelperError("NOT_FRONTMOST", "GarageBand must be frontmost for a click (call app.activate first)");
    if (node.enabled === false) throw new HelperError("TARGET_DISABLED", "the target is disabled; clicking it would do nothing");
    if ((node.actions ?? []).includes("AXPress")) throw new HelperError("INPUT_INVALID", "the target is pressable: use ax.press, not a click");
    if (this.mouseButtonDown) throw new HelperError("USER_INPUT_ACTIVE", "a mouse button is held: not clicking into your drag");
    if (this.userTyping) throw new HelperError("USER_INPUT_ACTIVE", "you are typing or moving the pointer right now: not clicking");
    if (this.coveredBy) {
      const hit = this.foreign.has(this.coveredBy) ? { foreign_app: true, role: this.coveredBy.role ?? "" } : compact(this.coveredBy, "?");
      throw new HelperError("HIT_TEST_MISMATCH", `another element (${this.coveredBy.role ?? "?"}) would receive the click`, { hit });
    }
    const before = compact(node, path);
    this.clicks.push(node);
    const b = this.behaviors.get(node);
    if (b?.onClick) b.onClick(node);
    else if (typeof node.selected === "boolean") {
      for (const sib of this.parentOf(node)?.children ?? []) if (sib.role === node.role && typeof sib.selected === "boolean") sib.selected = false;
      node.selected = true;
    }
    this.settle(p, 300);
    return { before, after: this.isAttached(node) ? compact(node, path) : null, point: { x: 0, y: 0 } };
  }

  private static readonly ALLOWED_ACTIONS = new Set(["AXConfirm"]); // mirrors the helper

  private perform(p: Record<string, unknown>, d: Deadline) {
    const action = typeof p.action === "string" ? p.action : "";
    if (!FakeHelper.ALLOWED_ACTIONS.has(action)) throw new HelperError("INPUT_INVALID", `action must be one of ${[...FakeHelper.ALLOWED_ACTIONS].sort().join(", ")}`);
    const { node, path } = this.resolveOne(p, d);
    if (node.enabled === false) throw new HelperError("TARGET_DISABLED", "the target is disabled");
    if (!(node.actions ?? []).includes(action)) throw new HelperError("NOT_SUPPORTED", `the target has no ${action} action`);
    const before = compact(node, path);
    this.behaviors.get(node)?.onAction?.(node, action);
    this.settle(p, 150);
    return { before, after: this.isAttached(node) ? compact(node, path) : null };
  }

  private parentOf(target: TreeNode): TreeNode | undefined {
    const visit = (n: TreeNode): TreeNode | undefined => {
      for (const c of n.children ?? []) {
        if (c === target) return n;
        const hit = visit(c);
        if (hit) return hit;
      }
      return undefined;
    };
    for (const w of this.app.windows) {
      const hit = visit(w);
      if (hit) return hit;
    }
    return undefined;
  }

  private menu(p: Record<string, unknown>) {
    this.requireAX();
    const path = Array.isArray(p.path) ? p.path.filter((t): t is string => typeof t === "string") : [];
    if (path.length === 0) throw new HelperError("INPUT_INVALID", "path must be a non-empty array of menu titles");
    let current = this.app.menubar;
    path.forEach((title, level) => {
      let candidates = current.children ?? [];
      if (level > 0) candidates = candidates.flatMap((c) => (c.role === "AXMenu" ? c.children ?? [] : [c]));
      const hits = candidates.filter((c) => c.title === title);
      if (hits.length !== 1) {
        throw new HelperError(hits.length === 0 ? "TARGET_NOT_FOUND" : "TARGET_AMBIGUOUS", `menu item "${title}" ${hits.length === 0 ? "not found" : "is ambiguous"}`, {
          at: title, level, available: candidates.map((c) => c.title).filter((t): t is string => !!t),
        });
      }
      current = hits[0]!;
    });
    const enabled = current.enabled !== false;
    const result = { path, enabled, mark: (current.mark as string | undefined) ?? null, pressed: false };
    if (p.dry_run === true) return result;
    if (!enabled) throw new HelperError("TARGET_DISABLED", `menu item "${path.join(" ▸ ")}" is disabled`);
    this.pressNode(current);
    return { ...result, pressed: true };
  }

  private wait(p: Record<string, unknown>, d: Deadline) {
    this.requireAX();
    if (p.selector === undefined) throw new HelperError("INPUT_INVALID", "selector is required");
    const sel = this.selector(p.selector);
    const condition = typeof p.condition === "string" ? p.condition : "present";
    if (!["present", "absent", "value_equals"].includes(condition)) throw new HelperError("INPUT_INVALID", "condition must be present, absent or value_equals");
    if (condition === "value_equals" && p.value === undefined) throw new HelperError("INPUT_INVALID", "value_equals needs value");
    const poll = Math.min(Math.max(num(p.poll_ms) ?? 100, 20), 2_000);
    const start = this.clockMs;
    for (;;) {
      let matches: { node: TreeNode; path: string }[] = [];
      try {
        const { node, prune } = this.resolveRoot(p.root, d);
        matches = findAll(node, sel, this.options(p, prune, 24, 20_000)).matches;
      } catch {
        matches = []; // a missing root counts as zero matches
      }
      const satisfied = condition === "present" ? matches.length > 0
        : condition === "absent" ? matches.length === 0
        : matches.length === 1 && matches[0]!.node.value === p.value;
      if (satisfied || d.remainingMs() < poll + 25) {
        return { satisfied, waited_ms: this.clockMs - start, count: matches.length, condition, ...(matches[0] ? { match: compact(matches[0].node, matches[0].path) } : {}) };
      }
      this.sleep(poll);
    }
  }

  private snapshot(p: Record<string, unknown>, d: Deadline) {
    this.requireAX();
    const { node: root, prune } = this.resolveRoot(p.root, d);
    const o = this.options(p, prune, 6, 300);
    const depthLimit = Math.min(o.maxDepth, 16);
    const nodeLimit = Math.min(o.maxNodes, 3_000);
    let count = 0;
    let truncated = false;
    const build = (node: TreeNode, path: string, depth: number): TreeNode | undefined => {
      if (count >= nodeLimit || d.expired()) {
        truncated = true;
        return undefined;
      }
      count++;
      const out: TreeNode = compact(node, path, p.include_help === true);
      const kids = node.children ?? [];
      if (kids.length === 0) return out;
      if (depth >= depthLimit || o.pruneRoles.has(node.role ?? "")) return { ...out, child_count: kids.length };
      const built: TreeNode[] = [];
      for (const [i, child] of kids.entries()) {
        const c = build(child, path === "" ? `${i}` : `${path}.${i}`, depth + 1);
        if (!c) break;
        built.push(c);
      }
      return { ...out, children: built };
    };
    return { root: build(root, "", 0) ?? null, node_count: count, truncated };
  }
}

// ---------------------------------------------------------------------------------------------------------------

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function pick(n: TreeNode, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((k) => n[k] !== undefined && n[k] !== "").map((k) => [k, n[k]]));
}

/** Compact node, identical in shape to the Swift helper's output. */
function compact(n: TreeNode, path: string, includeHelp = false): TreeNode {
  const out: TreeNode = { path, ...pick(n, ["role", "subrole", "title", "desc", "id"]) };
  if (n.value !== undefined) out.value = n.value;
  if (n.enabled === false) out.enabled = false;
  if (n.settable === true) out.settable = true;
  const actions = (n.actions ?? []).filter((a) => !NOISE_ACTIONS.has(a));
  if (actions.length > 0) out.actions = actions;
  if (typeof n.min === "number") out.min = n.min;
  if (typeof n.max === "number") out.max = n.max;
  if (includeHelp && typeof n.help === "string" && n.help) out.help = n.help;
  if (typeof n.selected === "boolean") out.selected = n.selected;
  return out;
}

function verifyIdentity(node: TreeNode, path: string, expect: unknown): void {
  if (expect === null || typeof expect !== "object") return;
  const actual = compact(node, path) as Record<string, unknown>;
  for (const [k, want] of Object.entries(expect as Record<string, unknown>)) {
    if (!["path", "role", "subrole", "title", "desc", "id"].includes(k)) continue;
    if ((actual[k] ?? "") !== want) {
      throw new HelperError("TARGET_CHANGED", `the target changed since it was resolved (${k})`, { expected: expect, actual });
    }
  }
}

/** Integer-range sliders (tempo 5–990, volume 0–233, pan 0–127, playhead) step by one; 0–1 sliders set directly. */
const isStepwise = (n: TreeNode) => typeof n.min === "number" && typeof n.max === "number" ? n.max - n.min > 2 : true;

function contains(root: TreeNode, target: TreeNode): boolean {
  if (root === target) return true;
  return (root.children ?? []).some((c) => contains(c, target));
}

// --------------------------------------------------------------------------------------------------- fixtures

const FIXTURES = new URL("../../test/fixtures/garageband-10.4.14/", import.meta.url);
const fixture = (name: string): TreeNode => JSON.parse(readFileSync(fileURLToPath(new URL(name, FIXTURES)), "utf8")) as TreeNode;

/** The live 10.4.14 menu bar (captured read-only, recent-file names stripped), plus the one checkmark seen live. */
function liveMenuBar(): TreeNode {
  const bar = fixture("menubar.json");
  const countIn = findAll(bar, { role: "AXMenuItem", title: "1 Bar", ancestors: [{ title: "Count-in" }] }).matches[0];
  if (countIn) countIn.node.mark = "✓";
  return bar;
}

/**
 * A GarageBand 10.4.14 app assembled from the recorded fixtures: main window = Control Bar (+ transport, LCD), the Tracks
 * area (2 track headers from track-header.json, 2 regions), Library and Smart Controls panels; export save panel from
 * export-sheet.json; menu bar captured live (menubar.json).
 */
export function garageBandFixtureApp(): FakeApp {
  const mainWindow: TreeNode = {
    role: "AXWindow", subrole: "AXStandardWindow", title: "Probe - Tracks", children: [
      fixture("control-bar.json"),
      { role: "AXGroup", desc: "Tracks", children: [
        fixture("track-header.json"),
        { role: "AXGroup", desc: "Tracks contents", children: [{ role: "AXLayoutItem", desc: "ProbeLead" }, { role: "AXLayoutItem", desc: "ProbeBass" }] },
      ] },
      fixture("library.json"), // as if shown via view.library
      fixture("smart-controls.json"), // as if shown via view.smart_controls
    ],
  };
  return {
    running: true,
    axTrusted: true,
    frontmost: false,
    installed: { path: "/Applications/GarageBand.app", version: "10.4.14", build: "6648" },
    permissions: { automation: { system_events: "not_running", garageband: "granted" }, screen_recording: false },
    windows: [mainWindow],
    menubar: liveMenuBar(),
  };
}

/** GarageBand behaviors layered on the fixture trees. */
function installGarageBandBehaviors(fake: FakeHelper): void {
  const app = fake.app;
  const walk = (n: TreeNode, chain: TreeNode[], visit: (n: TreeNode, chain: TreeNode[]) => void) => {
    visit(n, chain);
    (n.children ?? []).forEach((c) => walk(c, [...chain, n], visit));
  };
  for (const w of app.windows) {
    walk(w, [], (n, chain) => {
      // Track headers report AXSelected; GarageBand always has one track selected.
      if (n.role === "AXLayoutItem" && chain.at(-1)?.desc === "Tracks header") {
        n.selected = chain.at(-1)!.children?.[0] === n;
      }
      // Mute/Solo: GarageBand appends ", mute" / ", solo" to the track item's description.
      if (n.role === "AXCheckBox" && (n.desc === "Mute" || n.desc === "Solo")) {
        const item = [...chain].reverse().find((a) => a.role === "AXLayoutItem");
        if (!item) return;
        fake.on(n, {
          onPress: (box) => {
            box.value = box.value === 1 ? 0 : 1;
            const baseDesc = String(item.desc ?? "").replace(/(, (mute|solo))+$/, "");
            const box2 = (item.children ?? []).filter((c) => c.role === "AXCheckBox");
            const muted = box2.find((c) => c.desc === "Mute")?.value === 1;
            const soloed = box2.find((c) => c.desc === "Solo")?.value === 1;
            item.desc = baseDesc + (muted ? ", mute" : "") + (soloed ? ", solo" : "");
          },
        });
      }
    });
  }
  // Play toggles playback; the stop button reads “Stop” while playing and “Go to Beginning” while stopped.
  const main = app.windows[0];
  const play = main && findAll(main, { role: "AXCheckBox", title: "Play" }).matches[0]?.node;
  const stopButton = main && findAll(main, { role: "AXButton", description: "Stop" }).matches[0]?.node;
  const relabel = (playing: boolean) => {
    if (!stopButton) return;
    stopButton.title = playing ? "Stop" : "Go to Beginning";
    stopButton.desc = stopButton.title;
  };
  if (play) {
    fake.on(play, { onPress: (n) => { n.value = n.value === 1 ? 0 : 1; relabel(n.value === 1); } });
  }
  const playhead = (d: string) => main && findAll(main, { role: "AXSlider", description: d, ancestors: [{ role: "AXGroup", description: "Playhead Position" }] }).matches[0]?.node;
  if (stopButton && play) {
    fake.on(stopButton, { onPress: () => {
      if (play.value === 1) { play.value = 0; relabel(false); return; }
      for (const d of ["bar", "beat"]) { const s = playhead(d); if (s) s.value = 1; } // “Go to Beginning”
    } });
  }
  // Record ▸ Count-in ▸ None / 1 Bar / 2 Bars behave like radio items: the checkmark moves to the pressed one.
  const countIn = findAll(app.menubar, { role: "AXMenuItem", ancestors: [{ title: "Count-in" }] }).matches.map((m) => m.node);
  for (const item of countIn) fake.on(item, { onPress: (n) => { for (const o of countIn) o.mark = o === n ? "✓" : undefined; } });
  // Share ▸ Export Song to Disk… opens the save panel; its Export/Cancel close it.
  const exportItem = findAll(app.menubar, { role: "AXMenuItem", title: "Export Song to Disk…", ancestors: [{ title: "Share" }] }).matches[0]?.node;
  if (exportItem) {
    fake.on(exportItem, {
      onPress: () => {
        const panel = fixture("export-sheet.json");
        const closeButtons = findAll(panel, { role: "AXButton", identifier: "CancelButton" }).matches
          .concat(findAll(panel, { role: "AXButton", identifier: "OKButton" }).matches);
        for (const b of closeButtons) {
          fake.on(b.node, { onPress: () => app.windows.splice(app.windows.indexOf(panel), 1) });
        }
        app.windows.push(panel);
      },
    });
  }
}
