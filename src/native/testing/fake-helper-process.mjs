// A stand-in gb-helper process for HelperClient tests: speaks the JSON-lines protocol, and can be told to
// hang, crash, or emit garbage. Not shipped; never used outside tests.
import { createInterface } from "node:readline";
import { existsSync, writeFileSync } from "node:fs";

const reply = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
process.stderr.write("[fake-helper] ready\n");
let count = 0;

createInterface({ input: process.stdin }).on("line", (line) => {
  const req = JSON.parse(line);
  const p = req.params ?? {};
  switch (req.op) {
    case "hello":
      return reply({ id: req.id, ok: true, result: { version: "fake", protocol: 1, pid: process.pid, ax_trusted: true } });
    case "echo":
      return reply({ id: req.id, ok: true, result: p });
    case "deadline":
      return reply({ id: req.id, ok: true, result: { deadline_ms: req.deadline_ms } });
    case "sleep":
      return setTimeout(() => reply({ id: req.id, ok: true, result: { slept: p.ms } }), p.ms);
    case "count":
      count += 1;
      return reply({ id: req.id, ok: true, result: { count, pid: process.pid } });
    case "fail":
      return reply({ id: req.id, ok: false, error: { code: "TARGET_NOT_FOUND", message: "nothing there", details: { similar: [] } } });
    case "garbage":
      return process.stdout.write("this is not json\n");
    case "crash":
      return process.exit(3);
    case "app.state": // read-only op that crashes the FIRST time (marker file) to test the one-time retry
      if (process.env.CRASH_MARKER && !existsSync(process.env.CRASH_MARKER)) {
        writeFileSync(process.env.CRASH_MARKER, "crashed once");
        return process.exit(4);
      }
      return reply({ id: req.id, ok: true, result: { running: true, pid: process.pid } });
    case "ax.press": // mutating op that always crashes: must NOT be retried
      return process.exit(5);
    default:
      return reply({ id: req.id, ok: false, error: { code: "UNKNOWN_OP", message: `unknown op "${req.op}"` } });
  }
});
