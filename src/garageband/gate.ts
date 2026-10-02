// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { failed, type Envelope } from "../mcp/envelope.js";

export type GateOptions = {
  /**
   * A lock file shared by every gb-mcp process of this user (production: ~/Library/Caches/gb-mcp/garageband.lock):
   * two Claude sessions must not drive the one GarageBand at once, whatever their workspaces.
   */
  lockPath?: string;
};

/** No GarageBand mutation takes this long (an export waits ≤ 5 min): an older lock is stale even if its pid was reused. */
const MAX_LOCK_AGE_MS = 15 * 60_000;
/** An unreadable lock this young may be a contender mid-write (defensive: creation is atomic anyway). */
const YOUNG_MS = 10_000;

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};

type Holder = { pid: number; op: string };

/** Who holds the lock, or undefined when it is free or stale (dead process, too old, unreadable and not young). */
function lockHolder(lockPath: string): Holder | undefined {
  let ageMs: number;
  try { ageMs = Date.now() - statSync(lockPath).mtimeMs; } catch { return undefined; }
  if (ageMs > MAX_LOCK_AGE_MS) return undefined;
  try {
    const held = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown; op?: unknown };
    if (typeof held.pid !== "number") throw new Error("no pid");
    return held.pid !== process.pid && alive(held.pid) ? { pid: held.pid, op: String(held.op ?? "?") } : undefined;
  } catch {
    return ageMs < YOUNG_MS ? { pid: -1, op: "(being written)" } : undefined;
  }
}

type Acquired = { ok: true } | { ok: false; holder: Holder } | { ok: false; error: string };

/** Atomic create: the complete record is written to a temp file, then hard-linked into place (EEXIST = held). */
function acquire(lockPath: string, op: string): Acquired {
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
  } catch (e) {
    return { ok: false, error: (e as NodeJS.ErrnoException).code ?? "unknown" };
  }
  const tmp = `${lockPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ pid: process.pid, op, since: new Date().toISOString() }), { flag: "wx" });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        linkSync(tmp, lockPath);
        return { ok: true };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") return { ok: false, error: (e as NodeJS.ErrnoException).code ?? "unknown" };
        const holder = lockHolder(lockPath);
        if (holder) return { ok: false, holder };
        try { unlinkSync(lockPath); } catch { /* a contender took it over first: retry once */ }
      }
    }
    const holder = lockHolder(lockPath);
    return holder ? { ok: false, holder } : { ok: false, error: "contended" };
  } catch (e) {
    return { ok: false, error: (e as NodeJS.ErrnoException).code ?? "unknown" };
  } finally {
    try { unlinkSync(tmp); } catch { /* never created */ }
  }
}

function release(lockPath: string): void {
  try {
    const held = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown };
    if (held.pid === process.pid) unlinkSync(lockPath);
  } catch { /* already gone */ }
}

/**
 * One GarageBand mutation at a time: a second one is refused, never queued behind a modal flow. With a
 * lock path the rule holds across every gb-mcp process of the user.
 */
export function createMutationGate(opts: GateOptions = {}) {
  let busy: string | null = null;
  let lockPath = opts.lockPath;
  return {
    /** Set the shared lock file (production: ~/Library/Caches/gb-mcp/garageband.lock). */
    configure(o: GateOptions) { lockPath = o.lockPath; },
    async run(op: string, fn: () => Promise<Envelope>): Promise<Envelope> {
      if (busy) {
        return failed(op, "MUTATION_IN_PROGRESS", `${busy} is still running in GarageBand`, { safe_to_retry: true, hint: "wait for it to finish, then retry" });
      }
      const path = lockPath;
      if (path) {
        const got = acquire(path, op);
        if (!got.ok && "holder" in got) {
          return failed(op, "MUTATION_IN_PROGRESS", "another gb-mcp session is driving GarageBand", {
            safe_to_retry: true, hint: "wait for the other Claude session's GarageBand action to finish, then retry",
            context: { lock: path, holder_pid: got.holder.pid, holder_op: got.holder.op },
          });
        }
        if (!got.ok) {
          return failed(op, "WRITE_FAILED", "could not create the GarageBand lock file; nothing done", {
            hint: "check that the lock's folder is writable", context: { lock: path, reason: got.error },
          });
        }
      }
      busy = op;
      try {
        return await fn();
      } finally {
        busy = null;
        if (path) release(path);
      }
    },
  };
}

export const mutationGate = createMutationGate();
