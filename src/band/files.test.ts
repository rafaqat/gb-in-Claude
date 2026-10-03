// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { donorProblem } from "./files.js";

describe("donorProblem: total size", () => {
  it("refuses a donor whose files add up past the limit, though each file is small", () => {
    const donor = join(realpathSync(mkdtempSync(join(tmpdir(), "gbmcp-donor-"))), "big.band");
    mkdirSync(donor);
    for (let i = 0; i < 4; i++) writeFileSync(join(donor, `part${i}`), new Uint8Array(1000));
    expect(donorProblem(donor, 3999)).toMatchObject({ reason: "the donor's files add up to too many bytes" });
    expect(donorProblem(donor, 4000)).toBeUndefined();
  });
});
