// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { describe, it, expect } from "vitest";
import { parseScreenLocked } from "./screen.js";

const plist = (locked: boolean) => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>IOConsoleUsers</key><array><dict>
<key>CGSSessionScreenIsLocked</key><${locked}/><key>kCGSSessionOnConsoleKey</key><true/>
</dict></array></dict></plist>`;

describe("parseScreenLocked (ioreg -n Root -d1 -a)", () => {
  it("reads the console session's lock flag", () => {
    expect(parseScreenLocked(plist(true))).toBe(true);
    expect(parseScreenLocked(plist(false))).toBe(false);
  });

  it("treats a missing flag as unlocked (macOS omits it when never locked)", () => {
    expect(parseScreenLocked("<plist><dict></dict></plist>")).toBe(false);
  });
});
