// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { ok, err, type Result } from "../result.js";
import { parseWireLine } from "./protocol.js";
import { READ_ONLY_OPS, type CallOptions, type HelperFailure, type HelperPort } from "./helper-port.js";

/** Where build-helper.sh puts the signed binary (gb-mcp/native/bin/gb-helper). */
export const DEFAULT_HELPER_PATH = fileURLToPath(new URL("../../native/bin/gb-helper", import.meta.url));

export type HelperClientOptions = {
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  /** Deadline sent with each request when the caller gives none. */
  defaultDeadlineMs?: number;
  /** Extra client-side slack before a silent helper is declared wedged and killed. */
  graceMs?: number;
  /** Receives the helper's stderr lines (default: forwarded to our stderr — never stdout, which may be MCP). */
  log?: (line: string) => void;
};

type Pending = {
  id: number;
  resolve: (r: Result<unknown, HelperFailure>) => void;
  timer: NodeJS.Timeout;
};

/**
 * Manages one persistent gb-helper process speaking JSON-lines. Calls are serialized (one in flight), every call has
 * a deadline, a wedged helper is killed and replaced, garbage resyncs the stream with a fresh process, and a crash is
 * retried once ONLY for read-only ops (a mutating op may already have taken effect).
 */
export class HelperClient implements HelperPort {
  private proc: ChildProcessWithoutNullStreams | undefined;
  private pending: Pending | undefined;
  private nextId = 1;
  private queue: Promise<unknown> = Promise.resolve();
  private spawnError: string | undefined;
  private readonly command: string;
  private readonly defaultDeadlineMs: number;
  private readonly graceMs: number;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: HelperClientOptions = {}) {
    this.command = opts.command ?? DEFAULT_HELPER_PATH;
    this.defaultDeadlineMs = opts.defaultDeadlineMs ?? 2_000;
    this.graceMs = opts.graceMs ?? 1_000;
    this.log = opts.log ?? ((line) => process.stderr.write(`${line}\n`));
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  call(op: string, params: Record<string, unknown> = {}, callOpts: CallOptions = {}): Promise<Result<unknown, HelperFailure>> {
    const run = this.queue.then(() => this.exec(op, params, callOpts.deadlineMs ?? this.defaultDeadlineMs, true));
    this.queue = run.catch(() => undefined);
    return run;
  }

  async close(): Promise<void> {
    const p = this.proc;
    this.proc = undefined;
    if (!p || p.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => p.kill("SIGKILL"), 1_000);
      p.once("exit", () => {
        clearTimeout(force);
        resolve();
      });
      p.stdin.end();
      p.kill("SIGTERM");
    });
  }

  // ---------------------------------------------------------------------------------------------------------------

  private async exec(op: string, params: Record<string, unknown>, deadlineMs: number, mayRetry: boolean): Promise<Result<unknown, HelperFailure>> {
    const proc = await this.ensureProcess();
    if (!proc) {
      return err({
        code: "HELPER_UNAVAILABLE",
        message: `gb-helper could not be started (${this.spawnError ?? "unknown error"}); build it with native/build-helper.sh`,
      });
    }
    const id = this.nextId++;
    const result = await new Promise<Result<unknown, HelperFailure> | "exited">((resolve) => {
      // Every outcome (answer, timeout, exit) goes through finish(), which removes this call's listeners.
      const finish = (outcome: Result<unknown, HelperFailure> | "exited") => {
        clearTimeout(timer);
        proc.off("exit", onExit);
        if (this.pending?.id === id) this.pending = undefined;
        resolve(outcome);
      };
      const onExit = () => finish("exited");
      const timer = setTimeout(() => {
        this.kill(proc); // wedged: never reuse a helper that missed its deadline
        finish(err({ code: "DEADLINE_EXCEEDED", message: `gb-helper did not answer ${op} within ${deadlineMs + this.graceMs} ms` }));
      }, deadlineMs + this.graceMs);
      this.pending = { id, timer, resolve: (r) => finish(r) };
      proc.once("exit", onExit);
      try {
        proc.stdin.write(`${JSON.stringify({ id, op, params, deadline_ms: deadlineMs })}\n`);
      } catch {
        // EPIPE etc.: the exit handler reports it
      }
    });
    if (result !== "exited") return result;
    if (mayRetry && READ_ONLY_OPS.has(op)) return this.exec(op, params, deadlineMs, false);
    return err({
      code: "HELPER_UNAVAILABLE",
      message: `gb-helper exited during ${op}; it was not retried because ${READ_ONLY_OPS.has(op) ? "it already failed twice" : "a mutating op may already have taken effect"}`,
    });
  }

  private async ensureProcess(): Promise<ChildProcessWithoutNullStreams | undefined> {
    if (this.proc && this.proc.exitCode === null && !this.proc.killed) return this.proc;
    this.spawnError = undefined;
    const proc = spawn(this.command, this.opts.args ?? [], { env: this.opts.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    const started = await new Promise<boolean>((resolve) => {
      proc.once("spawn", () => resolve(true));
      proc.once("error", (e) => {
        this.spawnError = e.message;
        resolve(false);
      });
    });
    if (!started) return undefined;
    this.proc = proc;
    createInterface({ input: proc.stdout }).on("line", (line) => this.onLine(proc, line));
    createInterface({ input: proc.stderr }).on("line", (line) => this.log(line));
    proc.on("exit", () => {
      if (this.proc === proc) this.proc = undefined;
    });
    return proc;
  }

  private onLine(proc: ChildProcessWithoutNullStreams, line: string): void {
    const pending = this.pending;
    const wire = parseWireLine(line);
    if (!wire.ok) {
      // The stream is no longer trustworthy: fail the in-flight call and replace the process.
      if (pending) pending.resolve(err({ code: "HELPER_PROTOCOL_ERROR", message: `gb-helper wrote a non-protocol line (${wire.error})` }));
      this.kill(proc);
      return;
    }
    if (!pending || (wire.value.id !== null && wire.value.id !== pending.id)) return; // stale answer from a killed call
    const w = wire.value;
    pending.resolve(w.ok ? ok(w.result) : err({ code: w.error.code, message: w.error.message, ...(w.error.details !== undefined ? { details: w.error.details } : {}) }));
  }

  private kill(proc: ChildProcessWithoutNullStreams): void {
    if (this.proc === proc) this.proc = undefined;
    if (proc.exitCode === null) proc.kill("SIGKILL");
  }
}
