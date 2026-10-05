// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
/**
 * Client of the long-lived model sidecar (M8, models/gbmodels/server.py): one Python process keeps the models loaded;
 * requests and replies are JSON lines. Loading takes 10–20 s and a run well under 1 s, so the process is started on
 * the first request and kept. A crash fails the requests in flight and the next request starts a new process.
 * Never throws: every outcome is a Result.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { err, ok, type Result } from "../result.js";

export type SidecarError = {
  code: "SIDECAR_UNAVAILABLE" | "SIDECAR_CRASHED" | "SIDECAR_TIMEOUT" | "MODEL_FAILED" | "UNKNOWN_MODEL" | "WRONG_ENVIRONMENT" | "BAD_REQUEST";
  message: string;
};

export interface ModelSidecar {
  run(model: string, inputs: Record<string, unknown>): Promise<Result<unknown, SidecarError>>;
  close(): void;
}

/** env: extra variables for the process (on top of this process's own), e.g. GBMODELS_ENV for an M12 engine. */
export type SidecarOptions = { command: string; args: string[]; cwd: string; timeoutMs: number; startTimeoutMs?: number; env?: Record<string, string> };

type Pending = { resolve: (r: Result<unknown, SidecarError>) => void; timer: NodeJS.Timeout };

export function createModelSidecar(opts: SidecarOptions): ModelSidecar {
  let proc: ChildProcess | null = null;
  let ready: Promise<Result<void, SidecarError>> | null = null;
  let nextId = 1;
  const pending = new Map<number, Pending>();

  const failAll = (error: SidecarError) => {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.resolve(err(error));
      pending.delete(id);
    }
  };

  const start = (): Promise<Result<void, SidecarError>> =>
    new Promise((resolve) => {
      let settled = false;
      const settle = (r: Result<void, SidecarError>) => { if (!settled) { settled = true; resolve(r); } };
      const child = spawn(opts.command, opts.args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "ignore"], ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}) });
      proc = child;
      const startTimer = setTimeout(() => settle(err({ code: "SIDECAR_UNAVAILABLE", message: "the sidecar did not report ready in time" })), opts.startTimeoutMs ?? 60_000);
      child.on("error", (e) => {
        clearTimeout(startTimer);
        proc = null; ready = null;
        settle(err({ code: "SIDECAR_UNAVAILABLE", message: `cannot start the sidecar (${(e as NodeJS.ErrnoException).code ?? e.name})` }));
      });
      child.on("exit", (code) => {
        clearTimeout(startTimer);
        if (proc === child) { proc = null; ready = null; }
        settle(err({ code: "SIDECAR_UNAVAILABLE", message: `the sidecar exited before it was ready (code ${code})` }));
        failAll({ code: "SIDECAR_CRASHED", message: `the sidecar exited (code ${code}); the next request starts a new one` });
      });
      createInterface({ input: child.stdout! }).on("line", (line) => {
        let msg: { ready?: boolean; id?: number; ok?: boolean; result?: unknown; error?: { code: string; message: string } };
        try { msg = JSON.parse(line); } catch { return; } // not protocol: ignore (the sidecar sends libraries' output to stderr)
        if (msg.ready) { clearTimeout(startTimer); settle(ok(undefined)); return; }
        const p = typeof msg.id === "number" ? pending.get(msg.id) : undefined;
        if (!p) return;
        clearTimeout(p.timer);
        pending.delete(msg.id!);
        p.resolve(msg.ok ? ok(msg.result) : err({ code: (msg.error?.code ?? "MODEL_FAILED") as SidecarError["code"], message: msg.error?.message ?? "the sidecar reported a failure" }));
      });
    });

  return {
    async run(model, inputs) {
      ready ??= start();
      const started = await ready;
      if (!started.ok) { ready = null; return started; }
      const child = proc;
      if (!child?.stdin?.writable) { ready = null; return err({ code: "SIDECAR_CRASHED", message: "the sidecar is not running" }); }
      const id = nextId++;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve(err({ code: "SIDECAR_TIMEOUT", message: `${model} did not answer within ${opts.timeoutMs} ms` }));
        }, opts.timeoutMs);
        pending.set(id, { resolve, timer });
        child.stdin!.write(JSON.stringify({ id, op: "run", model, inputs }) + "\n");
      });
    },
    close() {
      failAll({ code: "SIDECAR_CRASHED", message: "the sidecar was closed" });
      proc?.stdin?.end();
      proc?.kill();
      proc = null; ready = null;
    },
  };
}
