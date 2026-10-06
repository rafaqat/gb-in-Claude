// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { z } from "zod";
import { ok, err, type Result } from "../result.js";
import type { CallOptions, HelperFailure, HelperOp, HelperPort } from "./helper-port.js";
import type { TreeNode } from "../ax/selector.js";

/** One response line from the helper. */
export const WireResponse = z.union([
  z.object({
    id: z.number().int().nullable(),
    ok: z.literal(true),
    result: z.unknown().refine((v) => v !== undefined, "result is required"),
  }).strict(),
  z.object({
    id: z.number().int().nullable(),
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
  }).strict(),
]);
export type WireResponse = z.infer<typeof WireResponse>;

export function parseWireLine(line: string): Result<WireResponse, string> {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return err("not JSON");
  }
  const r = WireResponse.safeParse(json);
  return r.success ? ok(r.data) : err(r.error.issues[0]?.message ?? "not a protocol response");
}

/** Compact AX node as the helper emits it (recursive in snapshots). */
export const AxNode: z.ZodType<TreeNode> = z.lazy(() =>
  z.object({
    path: z.string(),
    role: z.string().optional(),
    subrole: z.string().optional(),
    title: z.string().optional(),
    desc: z.string().optional(),
    id: z.string().optional(),
    value: z.union([z.string(), z.number(), z.boolean()]).optional(),
    enabled: z.boolean().optional(),
    settable: z.boolean().optional(),
    actions: z.array(z.string()).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    help: z.string().optional(),
    selected: z.boolean().optional(),
    child_count: z.number().optional(),
    children: z.array(AxNode).optional(),
  }).passthrough(),
) as z.ZodType<TreeNode>;

export const HelloResult = z.object({ version: z.string(), protocol: z.number(), pid: z.number(), ax_trusted: z.boolean() });
export const AutomationStatus = z.string(); // granted | denied | not_determined | not_running | error:<code>
export const PermCheckResult = z.object({
  accessibility: z.boolean(),
  automation: z.object({ system_events: AutomationStatus, garageband: AutomationStatus }),
  screen_recording: z.boolean(),
});
export const AppStateResult = z.object({
  bundle_id: z.string(),
  ax_trusted: z.boolean(),
  installed: z.object({ path: z.string(), version: z.string().nullable(), build: z.string().nullable() }).nullable(),
  running: z.boolean(),
  pid: z.number().optional(),
  frontmost: z.boolean().optional(),
  hidden: z.boolean().optional(),
  windows: z.array(z.object({ role: z.string().optional(), subrole: z.string().optional(), title: z.string().optional(), id: z.string().optional() })).optional(),
  dialog_count: z.number().optional(),
  sheet_count: z.number().optional(),
});
export const FindResult = z.object({ count: z.number(), matches: z.array(AxNode), truncated: z.boolean(), visited: z.number() });
export const PressResult = z.object({ before: AxNode, after: AxNode.nullable() });
const Scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const SetResult = z.object({ before: Scalar, after: Scalar, requested: Scalar });
export const ConvergeResult = z.object({
  converged: z.boolean(), steps: z.number(), target: z.number(), stuck: z.boolean(), deadline_exceeded: z.boolean(),
  before: z.number().nullable(), after: z.number().nullable(),
});
export const MenuResult = z.object({ path: z.array(z.string()), enabled: z.boolean(), mark: z.string().nullable(), pressed: z.boolean() });
export const WaitResult = z.object({
  satisfied: z.boolean(), waited_ms: z.number(), count: z.number(), condition: z.string(), match: AxNode.optional(),
  /** the whole tree under the root was searched (an "absent" from a cut-off search is never satisfied) */
  complete: z.boolean().optional(),
});
export const SnapshotResult = z.object({ root: AxNode.nullable(), node_count: z.number(), truncated: z.boolean() });
export const ActivateResult = z.object({ frontmost: z.boolean(), changed: z.boolean() });
export const RestoreFocusResult = z.object({ restored: z.boolean() });
export const ClickResult = z.object({ before: AxNode, after: AxNode.nullable(), point: z.object({ x: z.number(), y: z.number() }) });
export const PerformResult = z.object({ before: AxNode, after: AxNode.nullable() });

export type HelloResult = z.infer<typeof HelloResult>;
export type PermCheckResult = z.infer<typeof PermCheckResult>;
export type AppStateResult = z.infer<typeof AppStateResult>;
export type FindResult = z.infer<typeof FindResult>;
export type PressResult = z.infer<typeof PressResult>;
export type SetResult = z.infer<typeof SetResult>;
export type ConvergeResult = z.infer<typeof ConvergeResult>;
export type MenuResult = z.infer<typeof MenuResult>;
export type WaitResult = z.infer<typeof WaitResult>;
export type SnapshotResult = z.infer<typeof SnapshotResult>;
export type ClickResult = z.infer<typeof ClickResult>;

/** Call an op and parse its result with the op's schema: a schema mismatch is HELPER_PROTOCOL_ERROR, never data. */
export async function callOp<T>(
  port: HelperPort, op: HelperOp, params: Record<string, unknown>, schema: z.ZodType<T>, opts?: CallOptions,
): Promise<Result<T, HelperFailure>> {
  const r = await port.call(op, params, opts);
  if (!r.ok) return r;
  const parsed = schema.safeParse(r.value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return err({ code: "HELPER_PROTOCOL_ERROR", message: `${op} result does not match the protocol: ${issue?.path.join(".")} ${issue?.message}` });
  }
  return ok(parsed.data);
}
