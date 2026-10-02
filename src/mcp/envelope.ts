// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/**
 * The result contract. Every tool returns exactly one of these.
 * Canonical fields are written last so payload data can never overwrite them.
 */
export type ErrorCode =
  // input & song
  | "INPUT_INVALID"
  | "SONG_INVALID"
  | "VALIDATION_FAILED"
  | "RENDER_FAILED"
  // files & workspace
  | "PATH_INVALID"
  | "PATH_OUTSIDE_WORKSPACE"
  | "FILE_EXISTS"
  | "FILE_NOT_FOUND"
  | "WRITE_FAILED"
  // analysis & catalog
  | "AUDIO_INVALID"
  | "ANALYSIS_FAILED"
  | "DEPENDENCY_MISSING"
  | "CATALOG_UNAVAILABLE"
  | "NOT_SUPPORTED"
  // native helper & GarageBand
  | "HELPER_UNAVAILABLE"
  | "HELPER_PROTOCOL_ERROR"
  | "DEADLINE_EXCEEDED"
  | "PERMISSION_AX_DENIED"
  | "PERMISSION_AUTOMATION_DENIED"
  | "GB_NOT_RUNNING"
  | "SCREEN_LOCKED"
  | "GB_VERSION_UNSUPPORTED"
  | "NOT_FRONTMOST"
  | "HIT_TEST_MISMATCH"
  | "USER_INPUT_ACTIVE"
  | "INTERNAL_ERROR"
  | "NO_PROJECT_OPEN"
  | "CONTENT_NOT_INSTALLED"
  | "DIALOG_UNEXPECTED"
  | "TARGET_NOT_FOUND"
  | "TARGET_AMBIGUOUS"
  | "TARGET_CHANGED"
  | "READBACK_MISMATCH"
  | "TARGET_DISABLED"
  | "NOT_SETTABLE"
  | "AX_ACTION_FAILED"
  | "MUTATION_IN_PROGRESS";

/** Why an action's effect could not be confirmed (closed set). */
export type UncertainReason =
  | "readback_unavailable" // nothing observable to read back
  | "noop_unobservable" // target already held the value: cannot prove the action ran
  | "readback_timeout" // effect not observed within the deadline (may still land)
  | "delivered_unconfirmed"; // input was delivered (e.g. a press) but its effect is not exposed

export type Verified = { status: "verified"; op: string; data: unknown; warnings?: string[] };
export type Uncertain = {
  status: "uncertain";
  op: string;
  reason: UncertainReason;
  write_attempted: boolean;
  safe_to_retry: boolean;
  hint: string;
  data?: unknown;
};
export type Failed = {
  status: "failed";
  op: string;
  error: ErrorCode;
  message: string;
  write_attempted: boolean;
  safe_to_retry: boolean;
  recoverable: boolean;
  hint?: string;
  context?: unknown;
};
export type Envelope = Verified | Uncertain | Failed;

export const verified = (op: string, data: unknown, warnings?: string[]): Verified => ({
  data,
  ...(warnings && warnings.length > 0 ? { warnings } : {}),
  status: "verified",
  op,
});

export const uncertain = (
  op: string,
  reason: UncertainReason,
  extra: { write_attempted: boolean; safe_to_retry: boolean; hint: string; data?: unknown },
): Uncertain => ({
  ...(extra.data !== undefined ? { data: extra.data } : {}),
  status: "uncertain",
  op,
  reason,
  write_attempted: extra.write_attempted,
  safe_to_retry: extra.safe_to_retry,
  hint: extra.hint,
});

export const failed = (
  op: string,
  error: ErrorCode,
  message: string,
  extra: { write_attempted?: boolean; safe_to_retry?: boolean; recoverable?: boolean; hint?: string; context?: unknown } = {},
): Failed => ({
  ...(extra.hint ? { hint: extra.hint } : {}),
  ...(extra.context !== undefined ? { context: extra.context } : {}),
  message,
  status: "failed",
  op,
  error,
  write_attempted: extra.write_attempted ?? false,
  safe_to_retry: extra.safe_to_retry ?? true,
  recoverable: extra.recoverable ?? true,
});

/** MCP `isError` is set only for failures; `uncertain` is a normal result the agent must inspect. */
export const isErrorEnvelope = (e: Envelope): boolean => e.status === "failed";
