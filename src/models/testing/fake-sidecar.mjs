// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
// A stand-in for gbmodels.server in tests: same JSON-lines protocol, no models.
//   run "echo"  → returns its inputs        run "slow"  → never answers
//   run "crash" → the process exits          run other   → MODEL_FAILED
import { createInterface } from "node:readline";
process.stdout.write(JSON.stringify({ ready: true, env: ".venv", models: ["echo"], pid: process.pid }) + "\n");
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const req = JSON.parse(line);
  if (req.model === "echo") process.stdout.write(JSON.stringify({ id: req.id, ok: true, result: { inputs: req.inputs, pid: process.pid }, run_s: 0.01 }) + "\n");
  else if (req.model === "crash") process.exit(3);
  else if (req.model === "slow") return;
  else process.stdout.write(JSON.stringify({ id: req.id, ok: false, error: { code: "MODEL_FAILED", message: "no such model" } }) + "\n");
});
