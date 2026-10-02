// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { z } from "zod";
import { ok, err, type Result } from "../result.js";

/**
 * Structured AX selectors — the TypeScript twin of the Swift helper's AXSelector.
 * Every given field must match EXACTLY (no substring/prefix/fuzzy). "" matches an absent or empty attribute.
 * `ancestors` must match ancestors of the candidate in outer→inner order (the search root counts).
 * Parity with Swift is enforced by the shared vectors in native/gb-helper/Tests/vectors/selector-cases.json.
 */
export type Selector = {
  role?: string;
  subrole?: string;
  title?: string;
  description?: string;
  identifier?: string;
  value?: string | number | boolean;
  ancestors?: Selector[];
  index?: number;
};

export const SelectorSchema: z.ZodType<Selector> = z.lazy(() =>
  z
    .object({
      role: z.string().optional(),
      subrole: z.string().optional(),
      title: z.string().optional(),
      description: z.string().optional(),
      identifier: z.string().optional(),
      value: z.union([z.string(), z.number(), z.boolean()]).optional(),
      ancestors: z.array(SelectorSchema).optional(),
      index: z.number().int().min(0).optional(),
    })
    .strict()
    .refine(
      (s) => ["role", "subrole", "title", "description", "identifier", "value"].some((k) => (s as Record<string, unknown>)[k] !== undefined),
      "selector needs at least one of role/subrole/title/description/identifier/value",
    ),
) as z.ZodType<Selector>;

export function parseSelector(input: unknown): Result<Selector, string> {
  const r = SelectorSchema.safeParse(input);
  if (r.success) return ok(r.data);
  const issue = r.error.issues[0]!;
  return err(`${issue.path.join(".") || "selector"}: ${issue.message}`);
}

/** Accessibility tree node in the compact/fixture format shared with the helper's snapshots. */
export type TreeNode = {
  role?: string;
  subrole?: string;
  title?: string;
  desc?: string;
  id?: string;
  value?: unknown;
  enabled?: boolean;
  settable?: boolean;
  actions?: string[];
  min?: number;
  max?: number;
  help?: string;
  path?: string;
  children?: TreeNode[];
  child_count?: number;
  [extra: string]: unknown;
};

const FIELD_TO_NODE_KEY = { role: "role", subrole: "subrole", title: "title", description: "desc", identifier: "id" } as const;

export function matchesNode(node: TreeNode, s: Selector): boolean {
  for (const [field, key] of Object.entries(FIELD_TO_NODE_KEY) as [keyof typeof FIELD_TO_NODE_KEY, string][]) {
    const want = s[field];
    if (want === undefined) continue;
    const actual = (node[key] as string | undefined) ?? "";
    if (actual !== want) return false;
  }
  if (s.value !== undefined && node.value !== s.value) return false;
  return true;
}

function ancestorsSatisfied(chain: TreeNode[], s: Selector): boolean {
  const ancestors = s.ancestors ?? [];
  let i = 0;
  for (const node of chain) {
    if (i < ancestors.length && matchesNode(node, ancestors[i]!)) i++;
  }
  return i === ancestors.length;
}

export type SearchOptions = { maxDepth?: number; maxNodes?: number; pruneRoles?: Set<string> };
export type Match = { node: TreeNode; path: string; chain: TreeNode[] };
export type SearchResult = { matches: Match[]; visited: number; truncated: boolean };

/** Pre-order walk; matches in document order; `index` applied last. Mirrors the Swift findAll exactly. */
export function findAll(root: TreeNode, s: Selector, opts: SearchOptions = {}): SearchResult {
  const maxDepth = opts.maxDepth ?? 24;
  const maxNodes = opts.maxNodes ?? 20_000;
  const prune = opts.pruneRoles ?? new Set<string>();
  const result: SearchResult = { matches: [], visited: 0, truncated: false };
  const chain: TreeNode[] = [];

  const visit = (node: TreeNode, path: string, depth: number): void => {
    if (result.truncated) return;
    if (result.visited >= maxNodes) {
      result.truncated = true;
      return;
    }
    result.visited++;
    if (matchesNode(node, s) && ancestorsSatisfied(chain, s)) result.matches.push({ node, path, chain: [...chain] });
    if (depth >= maxDepth || prune.has(node.role ?? "")) return;
    chain.push(node);
    (node.children ?? []).forEach((child, i) => visit(child, path === "" ? `${i}` : `${path}.${i}`, depth + 1));
    chain.pop();
  };

  visit(root, "", 0);
  if (s.index !== undefined) result.matches = result.matches[s.index] ? [result.matches[s.index]!] : [];
  return result;
}

/** "" = root; "1.0.2" = root.children[1].children[0].children[2]. */
export function nodeAtPath(root: TreeNode, path: string): TreeNode | undefined {
  let current: TreeNode | undefined = root;
  for (const part of path === "" ? [] : path.split(".")) {
    current = current?.children?.[Number(part)];
  }
  return current;
}
