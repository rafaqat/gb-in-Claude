// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { ok, err, type Result } from "../result.js";
import { verified, uncertain, failed, type Envelope, type ErrorCode, type Failed } from "../mcp/envelope.js";
import type { HelperFailure, HelperPort } from "../native/helper-port.js";
import {
  callOp, FindResult, PressResult, SetResult, ConvergeResult, MenuResult, WaitResult, SnapshotResult, ClickResult,
  ActivateResult, RestoreFocusResult, PerformResult,
  type WaitResult as WaitResultT,
} from "../native/protocol.js";
import type { Selector, TreeNode } from "./selector.js";
import type { ControlKind, RootSpec } from "./locators.js";

/** Anything the core can act on: a registry ControlLocator or an ad-hoc root + selector + kind. */
export type Target = { root: RootSpec; selector: Selector; kind: ControlKind; prune_roles?: string[] };

/** An observable condition that proves an action took effect (e.g. "the export panel is present"). */
export type WaitSpec = {
  root: RootSpec;
  selector: Selector;
  condition: "present" | "absent" | "value_equals";
  value?: unknown;
  timeoutMs?: number;
};

export type AxCoreOptions = {
  /** Deadline for lookups (find/snapshot/menu). */
  lookupDeadlineMs?: number;
  /** Pause after an action before reading back. */
  settleMs?: number;
  /** How long to keep polling for an action's effect before reporting `uncertain`. */
  readbackTimeoutMs?: number;
};

const IDENTITY_KEYS = ["path", "role", "subrole", "title", "desc", "id"] as const;

export type ClickOptions = {
  /** Where to click, as fractions of the target's frame (default: the centre). */
  at?: { fx: number; fy: number };
  /** Verify by AXSelected reading back this value (track headers, rows). */
  expectSelected?: boolean;
  /** Verify by an observable effect (e.g. the header names the new patch). */
  postCondition?: WaitSpec;
  /** Repeating the click is harmless (default: true only for selections). */
  idempotent?: boolean;
};

/** helper code → envelope ErrorCode (internal/unknown helper codes degrade to HELPER_PROTOCOL_ERROR). */
const CODE_MAP: Record<string, ErrorCode> = {
  TARGET_NOT_FOUND: "TARGET_NOT_FOUND",
  TARGET_AMBIGUOUS: "TARGET_AMBIGUOUS",
  TARGET_CHANGED: "TARGET_CHANGED",
  DEADLINE_EXCEEDED: "DEADLINE_EXCEEDED",
  PERMISSION_AX_DENIED: "PERMISSION_AX_DENIED",
  GB_NOT_RUNNING: "GB_NOT_RUNNING",
  NOT_SUPPORTED: "NOT_SUPPORTED",
  NOT_SETTABLE: "NOT_SETTABLE",
  TARGET_DISABLED: "TARGET_DISABLED",
  AX_ACTION_FAILED: "AX_ACTION_FAILED",
  NOT_FRONTMOST: "NOT_FRONTMOST",
  HIT_TEST_MISMATCH: "HIT_TEST_MISMATCH",
  USER_INPUT_ACTIVE: "USER_INPUT_ACTIVE",
  PERMISSION_AUTOMATION_DENIED: "PERMISSION_AUTOMATION_DENIED",
  INPUT_INVALID: "INPUT_INVALID",
  HELPER_UNAVAILABLE: "HELPER_UNAVAILABLE",
  HELPER_PROTOCOL_ERROR: "HELPER_PROTOCOL_ERROR",
  UNKNOWN_OP: "HELPER_PROTOCOL_ERROR",
  HELPER_INTERNAL: "HELPER_PROTOCOL_ERROR",
};

const HINTS = {
  GB_NOT_RUNNING: "open GarageBand first (e.g. open a rendered .mid: `open -a GarageBand <file>`), then retry",
  PERMISSION_AX_DENIED: "grant Accessibility to the app that runs Claude Code (System Settings ▸ Privacy & Security ▸ Accessibility, e.g. Terminal), then retry; gb_system doctor shows the state",
  TARGET_NOT_FOUND: "the element is not in the current UI: show its panel first, or inspect it with gb_system ui_snapshot",
  TARGET_AMBIGUOUS: "several elements match: narrow the selector with ancestors (e.g. the track header) — never guess by position",
  TARGET_CHANGED: "the UI changed between finding and acting: re-read the state and try again",
  DEADLINE_EXCEEDED: "GarageBand did not answer in time — it may be busy or showing a modal dialog (gb_system ui_snapshot panel=dialog)",
  HELPER_UNAVAILABLE: "the native helper is not running: build it with gb-mcp/native/build-helper.sh; gb_system doctor shows details",
  HELPER_PROTOCOL_ERROR: "internal protocol error between gb-mcp and gb-helper; gb_system doctor checks the helper version",
  READBACK_MISMATCH: "the control did not take the value — GarageBand may be clamping it or showing a dialog; read the state before retrying",
  NOT_FRONTMOST: "GarageBand has to be frontmost for a real click and macOS refused to bring it forward: click its window once, then retry",
  HIT_TEST_MISMATCH: "something else is on top of the target (a popover, dialog, notification or another window) — nothing was clicked; clear it and retry",
  USER_INPUT_ACTIVE: "the user is typing or using the pointer — GarageBand was not brought forward (their keys would land in it); retry after a pause",
  PERMISSION_AUTOMATION_DENIED: "allow the app running Claude Code to control GarageBand (System Settings ▸ Privacy & Security ▸ Automation); gb_system doctor shows the state",
} as const satisfies Partial<Record<ErrorCode, string>>;
const hintFor = (code: ErrorCode): string | undefined => (HINTS as Partial<Record<ErrorCode, string>>)[code];

/** Codes that mean "we cannot know whether the action already happened". */
const UNKNOWN_OUTCOME = new Set(["HELPER_UNAVAILABLE", "DEADLINE_EXCEEDED", "HELPER_PROTOCOL_ERROR"]);

const identityOf = (n: TreeNode): Record<string, unknown> =>
  Object.fromEntries(IDENTITY_KEYS.filter((k) => n[k] !== undefined).map((k) => [k, n[k]]));

const brief = (n: TreeNode | null | undefined) => (n ? {
  ...identityOf(n), ...(n.value !== undefined ? { value: n.value } : {}), ...(typeof n.selected === "boolean" ? { selected: n.selected } : {}),
} : null);

const sameValue = (a: unknown, b: unknown) =>
  typeof a === "number" && typeof b === "number" ? Math.abs(a - b) <= 1e-6 : a === b;

/**
 * The verified-action layer over the native helper: resolve exactly one target, re-verify identity at action time,
 * act, then prove the effect by read-back. Returns the result envelope — never `verified` without evidence.
 */
export class AxCore {
  private readonly lookupDeadlineMs: number;
  private readonly settleMs: number;
  private readonly readbackTimeoutMs: number;

  constructor(private readonly port: HelperPort, opts: AxCoreOptions = {}) {
    this.lookupDeadlineMs = opts.lookupDeadlineMs ?? 4_000;
    this.settleMs = opts.settleMs ?? 150;
    this.readbackTimeoutMs = opts.readbackTimeoutMs ?? 1_500;
  }

  /** Exactly one element, or a failure that says why (with candidates / similar elements). */
  async resolve(op: string, t: Omit<Target, "kind">): Promise<Result<TreeNode, Failed>> {
    const params = { root: t.root, selector: t.selector, max_results: 6, ...(t.prune_roles ? { prune_roles: t.prune_roles } : {}) };
    const r = await callOp(this.port, "ax.find", params, FindResult, { deadlineMs: this.lookupDeadlineMs });
    if (!r.ok) return err(this.fail(op, r.error, false, true));
    if (r.value.count === 1) return ok(r.value.matches[0]!);
    if (r.value.count > 1) {
      return err(failed(op, "TARGET_AMBIGUOUS", `${r.value.count} elements match the selector`, {
        hint: HINTS.TARGET_AMBIGUOUS, context: { candidates: r.value.matches.map(brief) },
      }));
    }
    let similar: unknown[] = [];
    if (t.selector.role) {
      const near = await callOp(this.port, "ax.find", { root: t.root, selector: { role: t.selector.role }, max_results: 8 }, FindResult, { deadlineMs: this.lookupDeadlineMs });
      if (near.ok) similar = near.value.matches.map(brief);
    }
    return err(failed(op, "TARGET_NOT_FOUND", "no element matches the selector", { hint: HINTS.TARGET_NOT_FOUND, context: { similar } }));
  }

  async read(op: string, t: Omit<Target, "kind">): Promise<Envelope> {
    const node = await this.resolve(op, t);
    if (!node.ok) return node.error;
    return verified(op, { value: node.value.value ?? null, node: brief(node.value) });
  }

  /** Press a control and prove its effect according to its kind (toggle/radio read-back, or a post-condition). */
  async press(op: string, t: Target, opts: { postCondition?: WaitSpec; idempotent?: boolean } = {}): Promise<Envelope> {
    if (!["toggle", "radio", "button", "popup"].includes(t.kind)) {
      return failed(op, "INPUT_INVALID", `a ${t.kind} is set, not pressed`, { hint: "use set()" });
    }
    const resolved = await this.resolve(op, t);
    if (!resolved.ok) return resolved.error;
    const node = resolved.value;
    const retrySafe = t.kind === "radio" || opts.idempotent === true;

    const r = await callOp(this.port, "ax.press", { root: t.root, selector: t.selector, expect: identityOf(node), settle_ms: this.settleMs }, PressResult, {
      deadlineMs: this.lookupDeadlineMs + this.settleMs,
    });
    if (!r.ok) return this.fail(op, r.error, true, retrySafe);
    const { before, after } = r.value;

    if (t.kind === "toggle" || t.kind === "radio") {
      const expected = t.kind === "radio" ? 1 : before.value === 1 ? 0 : 1;
      if (!after) {
        return uncertain(op, "readback_unavailable", { write_attempted: true, safe_to_retry: retrySafe, hint: "the control vanished after the press; re-read the state", data: { before: brief(before) } });
      }
      let observed: TreeNode | undefined = sameValue(after.value, expected) ? after : undefined;
      if (!observed) {
        const w = await this.wait({ root: t.root, selector: { ...t.selector, value: expected as number } , condition: "present" });
        if (w.ok && w.value.satisfied) observed = w.value.match;
      }
      if (!observed) {
        return uncertain(op, "readback_timeout", {
          write_attempted: true, safe_to_retry: retrySafe,
          hint: retrySafe ? "the selection did not read back yet; re-read before retrying" : "the toggle did not read back as flipped — re-read its state; a blind retry could flip it twice",
          data: { before: brief(before), after: brief(after), expected },
        });
      }
      const post = await this.checkPost(opts.postCondition);
      if (post === false) return uncertain(op, "readback_timeout", { write_attempted: true, safe_to_retry: retrySafe, hint: "the control changed but its expected effect was not observed", data: { before: brief(before), after: brief(observed) } });
      return verified(op, { before: brief(before), after: brief(observed) });
    }

    // buttons / popups: no state of their own
    const post = await this.checkPost(opts.postCondition);
    if (post === undefined) {
      return uncertain(op, "delivered_unconfirmed", {
        write_attempted: true, safe_to_retry: retrySafe, hint: "pressed; this control has no readable state — confirm the effect before relying on it",
        data: { before: brief(before) },
      });
    }
    if (post === false) {
      return uncertain(op, "readback_timeout", { write_attempted: true, safe_to_retry: retrySafe, hint: "pressed, but the expected effect was not observed in time", data: { before: brief(before) } });
    }
    return verified(op, { before: brief(before), after: brief(after) });
  }

  /** Set a value. Stepwise sliders are converged with read-back; others are set once and read back. */
  async set(op: string, t: Target, value: number | string | boolean): Promise<Envelope> {
    if (["toggle", "radio", "button"].includes(t.kind)) return failed(op, "INPUT_INVALID", `a ${t.kind} is pressed, not set`, { hint: "use press()" });
    const resolved = await this.resolve(op, t);
    if (!resolved.ok) return resolved.error;
    const node = resolved.value;
    const expect = identityOf(node);

    if (t.kind === "stepwise_slider") {
      if (typeof value !== "number" || !Number.isFinite(value)) return failed(op, "INPUT_INVALID", "a slider needs a numeric value");
      const from = typeof node.value === "number" ? node.value : value;
      const settle = 120;
      const deadlineMs = Math.min(120_000, (Math.abs(value - from) + 2) * (settle + 40) + 1_500);
      const r = await callOp(this.port, "ax.converge", { root: t.root, selector: t.selector, target: value, expect, settle_ms: settle }, ConvergeResult, { deadlineMs: deadlineMs + 1_000 });
      if (!r.ok) return this.fail(op, r.error, true, true);
      const c = r.value;
      const data = { before: c.before, after: c.after, steps: c.steps, target: value };
      if (c.converged) return verified(op, data);
      if (c.deadline_exceeded) {
        return failed(op, "DEADLINE_EXCEEDED", `stopped at ${c.after} after ${c.steps} steps (target ${value})`, { write_attempted: c.steps > 0, safe_to_retry: true, hint: HINTS.DEADLINE_EXCEEDED, context: data });
      }
      return failed(op, "READBACK_MISMATCH", `the control ${c.stuck ? "stopped moving" : "ran out of steps"} at ${c.after} (target ${value})`, {
        write_attempted: c.steps > 0, safe_to_retry: true, hint: HINTS.READBACK_MISMATCH, context: data,
      });
    }

    const r = await callOp(this.port, "ax.set", { root: t.root, selector: t.selector, value, expect, settle_ms: this.settleMs }, SetResult, {
      deadlineMs: this.lookupDeadlineMs + this.settleMs,
    });
    if (!r.ok) return this.fail(op, r.error, true, true);
    const data = { before: r.value.before, after: r.value.after, requested: value };
    if (sameValue(r.value.after, value)) return verified(op, data);
    return failed(op, "READBACK_MISMATCH", "the control did not take the requested value (both are in context)", {
      write_attempted: true, safe_to_retry: true, hint: HINTS.READBACK_MISMATCH, context: data,
    });
  }

  /**
   * A real (HID) click at a fraction of the target's frame — only for what AX presses cannot do (track selection,
   * Library rows). The helper refuses unless GarageBand is frontmost and the element under the point IS the target
   * (or a non-control part of it). Verified by AXSelected read-back or a post-condition, never by the click itself.
   */
  async click(op: string, t: Omit<Target, "kind">, opts: ClickOptions = {}): Promise<Envelope> {
    const resolved = await this.resolve(op, t);
    if (!resolved.ok) return resolved.error;
    const retrySafe = opts.idempotent ?? opts.expectSelected === true; // selecting twice changes nothing
    const settle = 300;
    const r = await callOp(this.port, "ax.click", {
      root: t.root, selector: t.selector, expect: identityOf(resolved.value), settle_ms: settle,
      ...(opts.at ? { at: opts.at } : {}), ...(t.prune_roles ? { prune_roles: t.prune_roles } : {}),
    }, ClickResult, { deadlineMs: this.lookupDeadlineMs + settle });
    if (!r.ok) return this.fail(op, r.error, true, retrySafe);
    const { before, after } = r.value;

    if (opts.expectSelected !== undefined) {
      let observed = after?.selected === opts.expectSelected ? after : undefined;
      if (!observed) {
        const again = await this.resolve(op, t); // one late look: GarageBand may repaint the selection after the settle
        if (again.ok && again.value.selected === opts.expectSelected) observed = again.value;
      }
      if (!observed) {
        return uncertain(op, "readback_timeout", {
          write_attempted: true, safe_to_retry: retrySafe, hint: "clicked, but the selection did not read back; re-read before clicking again",
          data: { before: brief(before), after: brief(after) },
        });
      }
      const post = await this.checkPost(opts.postCondition);
      if (post === false) return uncertain(op, "readback_timeout", { write_attempted: true, safe_to_retry: retrySafe, hint: "clicked, but the expected effect was not observed", data: { before: brief(before), after: brief(observed) } });
      return verified(op, { before: brief(before), after: brief(observed) });
    }
    const post = await this.checkPost(opts.postCondition);
    if (post === true) return verified(op, { before: brief(before), after: brief(after) });
    return uncertain(op, post === undefined ? "delivered_unconfirmed" : "readback_timeout", {
      write_attempted: true, safe_to_retry: retrySafe,
      hint: post === undefined ? "clicked; confirm the effect before relying on it" : "clicked, but the expected effect was not observed in time",
      data: { before: brief(before) },
    });
  }

  /**
   * Run real clicks with GarageBand in front, then give focus back to the app the user was in — also when the work
   * fails. If GarageBand was already frontmost the user is working in it, so focus is left alone.
   */
  async withFocus(op: string, work: () => Promise<Envelope>): Promise<Envelope> {
    // up to ~6.5 s to find a 1 s pause in the user's typing (the helper keeps 1.5 s of the deadline for the switch)
    const a = await callOp(this.port, "app.activate", {}, ActivateResult, { deadlineMs: 8_000 });
    if (!a.ok) return this.fail(op, a.error, false, true);
    let restored = true;
    let result: Envelope;
    try {
      result = await work();
    } finally {
      if (a.value.changed) {
        const r = await callOp(this.port, "app.restore_focus", {}, RestoreFocusResult, { deadlineMs: 3_000 });
        restored = r.ok && r.value.restored;
      }
    }
    if (restored) return result;
    // Never silent: the user's app may not be in front any more.
    if (result.status === "failed") return { ...result, context: { ...(result.context as Record<string, unknown> | undefined), focus_restored: false } };
    return { ...result, data: { ...(result.data as Record<string, unknown> | undefined), focus_restored: false } } as Envelope;
  }

  /** Run one allow-listed AX action (AXConfirm on a search field, AXIncrement…), proven by a post-condition. */
  async perform(op: string, t: Omit<Target, "kind">, action: string, opts: { postCondition?: WaitSpec; idempotent?: boolean } = {}): Promise<Envelope> {
    const resolved = await this.resolve(op, t);
    if (!resolved.ok) return resolved.error;
    const retrySafe = opts.idempotent === true;
    const r = await callOp(this.port, "ax.perform", {
      root: t.root, selector: t.selector, action, expect: identityOf(resolved.value), settle_ms: this.settleMs,
      ...(t.prune_roles ? { prune_roles: t.prune_roles } : {}),
    }, PerformResult, { deadlineMs: this.lookupDeadlineMs + this.settleMs });
    if (!r.ok) return this.fail(op, r.error, true, retrySafe);
    const post = await this.checkPost(opts.postCondition);
    if (post === true) return verified(op, { before: brief(r.value.before), after: brief(r.value.after) });
    return uncertain(op, post === undefined ? "delivered_unconfirmed" : "readback_timeout", {
      write_attempted: true, safe_to_retry: retrySafe, hint: `${action} was delivered; confirm its effect before relying on it`, data: { before: brief(r.value.before) },
    });
  }

  /** Walk a menu by full title path; dry run reads enabled/checkmark without pressing. */
  async menu(op: string, path: string[], opts: { dryRun?: boolean; postCondition?: WaitSpec; idempotent?: boolean } = {}): Promise<Envelope> {
    const r = await callOp(this.port, "ax.menu", { path, dry_run: opts.dryRun === true }, MenuResult, { deadlineMs: this.lookupDeadlineMs });
    if (!r.ok) return this.fail(op, r.error, opts.dryRun !== true, opts.idempotent === true);
    if (!r.value.pressed) return verified(op, r.value);
    const post = await this.checkPost(opts.postCondition);
    if (post === true) return verified(op, r.value);
    return uncertain(op, post === undefined ? "delivered_unconfirmed" : "readback_timeout", {
      write_attempted: true, safe_to_retry: opts.idempotent === true,
      hint: "the menu item was pressed; confirm its effect before pressing again (it may open a second dialog)", data: r.value,
    });
  }

  async wait(spec: WaitSpec): Promise<Result<WaitResultT, HelperFailure>> {
    const timeout = spec.timeoutMs ?? this.readbackTimeoutMs;
    return callOp(this.port, "ax.wait", {
      root: spec.root, selector: spec.selector, condition: spec.condition, poll_ms: 100,
      ...(spec.value !== undefined ? { value: spec.value } : {}),
    }, WaitResult, { deadlineMs: timeout });
  }

  async snapshot(op: string, root: RootSpec, opts: { depth?: number; maxNodes?: number; includeHelp?: boolean } = {}): Promise<Envelope> {
    const r = await callOp(this.port, "ax.snapshot", {
      root, ...(opts.depth ? { depth: opts.depth } : {}), ...(opts.maxNodes ? { max_nodes: opts.maxNodes } : {}), include_help: opts.includeHelp === true,
    }, SnapshotResult, { deadlineMs: this.lookupDeadlineMs * 2 });
    if (!r.ok) return this.fail(op, r.error, false, true);
    return verified(op, r.value);
  }

  // -------------------------------------------------------------------------------------------------------------

  /** true = satisfied, false = not observed in time, undefined = no post-condition given. */
  private async checkPost(spec: WaitSpec | undefined): Promise<boolean | undefined> {
    if (!spec) return undefined;
    const w = await this.wait(spec);
    return w.ok && w.value.satisfied;
  }

  /** Map a helper failure to the envelope, deciding whether a write may already have happened. */
  private fail(op: string, f: HelperFailure, actionStage: boolean, retrySafeAfterWrite: boolean): Failed {
    const code = CODE_MAP[f.code] ?? "HELPER_PROTOCOL_ERROR";
    const details = (f.details ?? {}) as Record<string, unknown>;
    const wrote = actionStage && (details.ax_error !== undefined || UNKNOWN_OUTCOME.has(f.code));
    const hint = hintFor(code);
    return failed(op, code, f.message, {
      write_attempted: wrote,
      safe_to_retry: wrote ? retrySafeAfterWrite : true,
      recoverable: true,
      ...(hint ? { hint } : {}),
      ...(Object.keys(details).length > 0 ? { context: details } : {}),
    });
  }
}
