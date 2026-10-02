// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { parseGrid } from "./drum-grid.js";

describe("parseGrid: dynamics, bars, resolutions", () => {
  it("X = accent (120), o = ghost (55)", () => {
    const out = parseGrid("X.o.", 4);
    expect(out.ok && out.value.hits).toEqual([
      { startBeat: 0, velocity: 120 },
      { startBeat: 2, velocity: 55 },
    ]);
  });

  it("| separates bars; positions continue across bars; spaces are ignored", () => {
    const out = parseGrid("x... .... | ..x. ....", 4);
    expect(out.ok && out.value).toEqual({
      bars: 2,
      hits: [{ startBeat: 0, velocity: 100 }, { startBeat: 5, velocity: 100 }],
    });
  });

  it("supports 8-step bars (8th notes) and 32-step bars (32nds)", () => {
    expect(parseGrid("x.x.x.x.", 4).ok && parseGrid("x.x.x.x.", 4)).toMatchObject({ value: { hits: [
      { startBeat: 0 }, { startBeat: 1 }, { startBeat: 2 }, { startBeat: 3 }] } });
    const fine = parseGrid("x" + ".".repeat(31), 4);
    expect(fine.ok && fine.value.hits).toEqual([{ startBeat: 0, velocity: 100 }]);
  });

  it.each([
    ["unknown character", "x..y"],
    ["step count that doesn't divide a bar evenly (12 in 4/4 is fine, 10 is not)", "x........."],
    ["bars with different step counts", "x... | x......."],
    ["empty bar", "x... | "],
  ])("rejects %s", (_label, input) => {
    const out = parseGrid(input, 4);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("INVALID_GRID");
  });
});

describe("parseGrid", () => {
  it("parses a 16-step bar: x = hit, . = rest, positions in beats", () => {
    expect(parseGrid("x...x...x...x...", 4)).toEqual({
      ok: true,
      value: {
        bars: 1,
        hits: [
          { startBeat: 0, velocity: 100 },
          { startBeat: 1, velocity: 100 },
          { startBeat: 2, velocity: 100 },
          { startBeat: 3, velocity: 100 },
        ],
      },
    });
  });
});
