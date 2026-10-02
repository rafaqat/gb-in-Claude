// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { ok, err, type Result } from "../result.js";

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 200;

export type PageRequest = { limit?: number | undefined; offset?: number | undefined; fields?: string[] | undefined };
export type Page<T> = { total: number; offset: number; limit: number; returned: number; items: Partial<T>[] };

/** Project items to a field mask; unknown fields are an error that lists the valid ones. */
export function projectFields<T extends object>(
  items: readonly T[],
  fields: readonly string[] | undefined,
  allowedFields: readonly (keyof T & string)[],
): Result<Partial<T>[], string> {
  const unknown = (fields ?? []).find((f) => !allowedFields.includes(f as keyof T & string));
  if (unknown !== undefined) return err(`unknown field "${unknown}"; valid fields: ${allowedFields.join(", ")}`);
  if (!fields) return ok([...items]);
  return ok(items.map((item) => Object.fromEntries(fields.map((f) => [f, (item as Record<string, unknown>)[f]])) as Partial<T>));
}

export const clampLimit = (limit: number | undefined) => Math.min(Math.max(1, limit ?? DEFAULT_LIMIT), MAX_LIMIT);
export const clampOffset = (offset: number | undefined) => Math.max(0, offset ?? 0);

/** Context-window discipline: total + one page, optionally projected to a field mask. */
export function paginate<T extends object>(
  items: readonly T[],
  req: PageRequest,
  allowedFields: readonly (keyof T & string)[],
): Result<Page<T>, string> {
  const limit = clampLimit(req.limit);
  const offset = clampOffset(req.offset);
  const projected = projectFields(items.slice(offset, offset + limit), req.fields, allowedFields);
  if (!projected.ok) return projected;
  return ok({ total: items.length, offset, limit, returned: projected.value.length, items: projected.value });
}
