// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseSelector, findAll, nodeAtPath, type TreeNode } from "./selector.js";

/** The SAME vectors the Swift helper is tested against (native/gb-helper/Tests/vectors). */
const vectors = JSON.parse(readFileSync(fileURLToPath(new URL("../../native/gb-helper/Tests/vectors/selector-cases.json", import.meta.url)), "utf8")) as {
  tree: TreeNode;
  cases: { name: string; root?: string; selector: unknown; prune_roles?: string[]; expect: string[] }[];
  invalid_selectors: { name: string; selector: unknown }[];
};

describe("selector parity with the Swift helper (shared vectors)", () => {
  for (const c of vectors.cases) {
    it(c.name, () => {
      const selector = parseSelector(c.selector);
      expect(selector.ok).toBe(true);
      if (!selector.ok) return;
      const root = nodeAtPath(vectors.tree, c.root ?? "")!;
      const found = findAll(root, selector.value, { pruneRoles: new Set(c.prune_roles ?? []) });
      expect(found.matches.map((m) => m.path)).toEqual(c.expect);
    });
  }

  for (const c of vectors.invalid_selectors) {
    it(`rejects: ${c.name}`, () => {
      expect(parseSelector(c.selector).ok).toBe(false);
    });
  }
});
