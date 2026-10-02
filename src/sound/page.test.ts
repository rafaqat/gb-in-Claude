// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { paginate } from "./page.js";

const items = Array.from({ length: 30 }, (_, i) => ({ id: i, name: `n${i}`, path: `/p/${i}` }));
const FIELDS = ["id", "name", "path"] as const;

describe("paginate", () => {
  it("returns total + a first page of 25 by default", () => {
    const out = paginate(items, {}, FIELDS);
    expect(out.ok && { ...out.value, items: out.value.items.length }).toEqual({ total: 30, offset: 0, limit: 25, returned: 25, items: 25 });
  });

  it("honours offset/limit and projects to the requested fields only", () => {
    const out = paginate(items, { offset: 28, limit: 5, fields: ["name"] }, FIELDS);
    expect(out.ok && out.value).toEqual({ total: 30, offset: 28, limit: 5, returned: 2, items: [{ name: "n28" }, { name: "n29" }] });
  });

  it("rejects unknown fields, listing the valid ones", () => {
    expect(paginate(items, { fields: ["name", "secret"] }, FIELDS))
      .toEqual({ ok: false, error: 'unknown field "secret"; valid fields: id, name, path' });
  });
});
