// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/**
 * Names read from disk or the loops DB are untrusted data: line breaks/tabs become spaces,
 * other control characters (C0, DEL, C1) and invisible formatting characters are dropped, whitespace is collapsed,
 * length is capped.
 */
/** Invisible or format characters that can disguise or hide text: all of Cc/Cf (bidi controls, zero-widths, BOM,
 *  soft hyphen, U+061C, U+180E, the Unicode TAG block used to smuggle invisible instructions) + variation selectors. */
export const INVISIBLE = /[\p{Cc}\p{Cf}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu;

export function cleanText(input: string, max = 120): string {
  const flat = input
    .replace(/[\t\n\r\v\f]/g, " ")
    .replace(INVISIBLE, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
