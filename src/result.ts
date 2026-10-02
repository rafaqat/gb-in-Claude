// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/** Errors are values: pure helpers return a Result instead of throwing. */
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
