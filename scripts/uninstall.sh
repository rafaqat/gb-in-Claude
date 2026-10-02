#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
#
# Remove gb-mcp's Claude Code registration and the skills it installed (only copies that are unchanged).
# Your songs, MIDI files and exports in the workspace are never touched.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SCOPE="${GB_MCP_SCOPE:-user}"
if command -v claude >/dev/null 2>&1 && claude mcp get gb-mcp >/dev/null 2>&1; then
  claude mcp remove gb-mcp -s "$SCOPE" && echo "✓ removed the gb-mcp MCP server ($SCOPE scope)"
else
  echo "· gb-mcp is not registered with Claude Code"
fi
for src in "$REPO"/skills/*/; do
  name="$(basename "$src")"; dst="$HOME/.claude/skills/$name"
  if [ -d "$dst" ] && diff -rq "$src" "$dst" >/dev/null 2>&1; then rm -rf "$dst" && echo "✓ removed skill $name"
  elif [ -d "$dst" ]; then echo "· kept $dst (it differs from the repo copy)"; fi
done
echo "Done. To remove everything else, delete this folder (node_modules, .venv and native/bin are inside it)."
