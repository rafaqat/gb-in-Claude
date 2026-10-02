// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import type { Result } from "../result.js";

/** Ops the gb-helper understands (protocol 1). */
export const HELPER_OPS = [
  "hello", "perm.check", "app.state",
  "ax.snapshot", "ax.find", "ax.press", "ax.set", "ax.converge", "ax.menu", "ax.wait",
  // focus + real clicks for what AX presses cannot do (track selection, Library rows); allow-listed AX actions
  "app.activate", "app.restore_focus", "ax.click", "ax.perform",
] as const;
export type HelperOp = (typeof HELPER_OPS)[number];

/** Ops that never change GarageBand's state — safe to retry after a helper crash. */
export const READ_ONLY_OPS: ReadonlySet<string> = new Set(["hello", "perm.check", "app.state", "ax.snapshot", "ax.find", "ax.wait"]);

/** A helper-level failure: `code` is a helper code (aligned with envelope ErrorCodes where one exists). */
export type HelperFailure = { code: string; message: string; details?: unknown };

export type CallOptions = { deadlineMs?: number };

/**
 * The seam between gb-mcp and the native helper. Implemented by HelperClient (real process) and
 * FakeHelper (FakeAX: fixtures + simulated GarageBand semantics) so everything above runs without GarageBand.
 */
export interface HelperPort {
  call(op: string, params?: Record<string, unknown>, opts?: CallOptions): Promise<Result<unknown, HelperFailure>>;
  close(): Promise<void>;
}
