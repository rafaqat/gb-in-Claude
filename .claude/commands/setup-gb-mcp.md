---
description: Install gb-mcp (dependencies, native helpers, analysis environment, MCP registration, skills) and verify it
---
Install gb-mcp from this repository for me:

1. Run `./scripts/install.sh --dry-run` and summarise what it will do. Then run `./scripts/install.sh`.
2. If a prerequisite is missing, tell me the exact command to install it (for example `xcode-select --install` or
   `brew install node`) — do not install system software without asking me first.
3. When it succeeds, tell me to restart Claude Code, grant Accessibility to the app I run Claude Code in
   (System Settings ▸ Privacy & Security ▸ Accessibility), and export one song by hand into the workspace's
   `exports` folder in GarageBand.
4. After I restart, call the `gb_system` tool with `{"command": "doctor"}` and explain every check that is not ✓.
