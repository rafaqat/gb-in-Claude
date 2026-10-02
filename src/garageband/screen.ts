// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { execFile } from "node:child_process";

/** CGSSessionScreenIsLocked from `ioreg -n Root -d1 -a` (XML plist). Missing flag = never locked. */
export function parseScreenLocked(plistXml: string): boolean {
  return /<key>CGSSessionScreenIsLocked<\/key>\s*<true\s*\/>/.test(plistXml);
}

/** While the screen is locked macOS gives apps no usable windows (live finding): GarageBand automation must wait. */
export function isScreenLocked(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("ioreg", ["-n", "Root", "-d1", "-a"], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? false : parseScreenLocked(stdout));
    });
  });
}
