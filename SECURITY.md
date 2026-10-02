# Security

gb-mcp is driven by an AI agent. It treats the agent as **not trusted**: tool arguments may be hallucinated or
steered by text the agent read, so every tool parses its input, touches only the workspace and GarageBand, proves the
effect of what it did, and refuses rather than guesses.

## What it does and does not do

- **Files** — reads and writes only inside the workspace (`GB_MCP_WORKSPACE`). Paths are resolved through symlinks and
  contained; percent-encodings, `?`, `#` and control characters are refused. Output names are plain names, never paths.
  Files are never overwritten (exclusive create) and never deleted. Unsaved GarageBand projects are copied into
  `sessions/` before anything can discard them.
- **Processes** — no shell. Subprocesses (`osascript`, `open`, `ioreg`, `python3`, the native helpers) get argument
  arrays and deadlines. AppleScripts are constants; values travel as arguments, never inside the script text.
- **Network** — none. MCP runs over stdio; there is no telemetry.
- **GarageBand only** — the native helper talks to `com.apple.garageband10` only (a constant, never taken from a
  request). Targets must match exactly one element; identity is re-checked right before acting.
- **Input** — no keystrokes are ever sent. Real mouse clicks are used only where GarageBand ignores Accessibility
  presses (selecting a track, choosing a Library sound) and only when: GarageBand is in front, the element under the
  pointer is the intended target, no mouse button is held and you have paused typing. GarageBand is brought forward
  just for the click and your previous app comes back right after.
- **Dialogs and downloads** — dialogs gb-mcp did not cause are never answered. Sounds whose content is not installed
  are never loaded, so no download is ever started.
- **Concurrency** — one GarageBand action at a time, also across Claude Code sessions (a lock file in
  `~/Library/Caches/gb-mcp`).
- **Untrusted text** — names and text read from GarageBand or disk are returned as data. Invisible and control
  characters (including bidi controls and Unicode tag characters) are stripped from every result, and long strings are
  capped.
- **Permissions** — Accessibility and Automation are checked without prompting; the doctor reports them. Screen
  Recording is not used.

## Known limits

- The first AppleScript listing of GarageBand documents can show the macOS Automation consent prompt once.
- System tools are found through `PATH`; the native helpers are ad-hoc signed.
- Sanitising removes hidden characters, not visible text that reads like an instruction — the agent must treat tool
  results as data.
- Changes made inside GarageBand (mute, volume, instrument …) edit the open project directly; use GarageBand's Undo.

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting** (Security ▸ Report a vulnerability) rather than a public
issue.
