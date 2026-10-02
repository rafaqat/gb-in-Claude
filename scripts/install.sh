#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
#
# Install gb-mcp for Claude Code: Node dependencies, native helpers (Swift), the audio-analysis environment
# (Python venv), the MCP server registration and the skills. Safe to re-run.
#
#   ./scripts/install.sh               install everything (MCP registered for your user)
#   ./scripts/install.sh --dry-run     print what would happen, change nothing
#   ./scripts/install.sh --no-register skip `claude mcp add`        --no-skills  skip installing the skills
#
# Environment: GB_MCP_WORKSPACE (default ~/Music/gb-mcp) — where songs, MIDI files and exports go.
#              GB_MCP_SCOPE (default user) — Claude Code scope for the MCP server: user, project or local.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORKSPACE="${GB_MCP_WORKSPACE:-$HOME/Music/gb-mcp}"
SCOPE="${GB_MCP_SCOPE:-user}"
SKILLS_DIR="$HOME/.claude/skills"
DRY=0; REGISTER=1; SKILLS=1
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --no-register) REGISTER=0 ;;
    --no-skills) SKILLS=0 ;;
    -h|--help) sed -n '5,14p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg (see --help)" >&2; exit 2 ;;
  esac
done

bold() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
ok()   { if [ "$DRY" = 1 ]; then printf '  · (dry run) %s\n' "$*"; else printf '  ✓ %s\n' "$*"; fi; }
warn() { printf '  ! %s\n' "$*"; }
die()  { printf '  ✗ %s\n' "$*" >&2; exit 1; }
run()  { if [ "$DRY" = 1 ]; then printf '  (dry run) %s\n' "$*"; else "$@"; fi; }

bold "Checking prerequisites"
[ "$(uname -s)" = "Darwin" ] || die "gb-mcp needs macOS (it drives GarageBand)."
command -v node >/dev/null 2>&1 || die "Node.js 22.13+ is required: https://nodejs.org (or: brew install node)"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' \
  || die "Node.js 22.13+ is required (found $(node -v))."
ok "Node $(node -v)"
command -v swift >/dev/null 2>&1 || die "Swift is required for the native helpers: xcode-select --install"
ok "$(swift --version 2>/dev/null | head -1)"
command -v python3 >/dev/null 2>&1 || die "Python 3 is required for audio analysis (brew install python)."
ok "$(python3 --version)"
if [ -d /Applications/GarageBand.app ]; then ok "GarageBand found"; else warn "GarageBand is not in /Applications — install it from the App Store."; fi
if command -v claude >/dev/null 2>&1; then ok "Claude Code CLI found"; else warn "Claude Code CLI not found — the MCP server will not be registered (see the README)."; REGISTER=0; fi

bold "Installing Node dependencies"
run bash -c "cd '$REPO' && npm ci --no-audit --no-fund"

bold "Building the native helpers (Swift)"
run bash -c "cd '$REPO' && npm run build:native"

bold "Creating the audio-analysis environment (.venv)"
[ -x "$REPO/.venv/bin/python3" ] || run python3 -m venv "$REPO/.venv"
run "$REPO/.venv/bin/python3" -m pip install --quiet --disable-pip-version-check -r "$REPO/analysis/requirements.txt"
ok "numpy, scipy, soundfile and matplotlib in $REPO/.venv"

bold "Creating the workspace"
run mkdir -p "$WORKSPACE/exports"
ok "$WORKSPACE  (exports land in $WORKSPACE/exports)"

TSX="$REPO/node_modules/.bin/tsx"; ENTRY="$REPO/src/index.ts"; PY="$REPO/.venv/bin/python3"
if [ "$REGISTER" = 1 ]; then
  bold "Registering the MCP server with Claude Code (scope: $SCOPE)"
  if claude mcp get gb-mcp >/dev/null 2>&1; then run claude mcp remove gb-mcp -s "$SCOPE" >/dev/null 2>&1 || true; fi
  run claude mcp add gb-mcp -s "$SCOPE" -e "GB_MCP_WORKSPACE=$WORKSPACE" -e "GB_MCP_PYTHON=$PY" -- "$TSX" "$ENTRY"
  ok "registered as 'gb-mcp'"
else
  bold "Register the MCP server yourself when ready:"
  echo "    claude mcp add gb-mcp -s user -e GB_MCP_WORKSPACE=\"$WORKSPACE\" -e GB_MCP_PYTHON=\"$PY\" -- \"$TSX\" \"$ENTRY\""
fi

if [ "$SKILLS" = 1 ]; then
  bold "Installing the skills into $SKILLS_DIR"
  run mkdir -p "$SKILLS_DIR"
  for src in "$REPO"/skills/*/; do
    name="$(basename "$src")"; dst="$SKILLS_DIR/$name"
    if [ -e "$dst" ] && ! diff -rq "$src" "$dst" >/dev/null 2>&1; then
      warn "$name: a different $dst already exists — left as is"
    else
      run mkdir -p "$dst" && run cp -R "$src". "$dst/" && ok "$name"
    fi
  done
fi

bold "Next steps"
cat <<NEXT
  1. Restart Claude Code so it loads the gb-mcp server.
  2. Give the app you run Claude Code in (Terminal, iTerm2, VS Code, …) Accessibility access:
     System Settings ▸ Privacy & Security ▸ Accessibility.
  3. Open GarageBand once and export any song to $WORKSPACE/exports by hand
     (Share ▸ Export Song to Disk… ▸ Where ▸ Other…) — gb-mcp then finds that folder in the save panel.
  4. In Claude Code, say:  run the gb-mcp doctor
NEXT
