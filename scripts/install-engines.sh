#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
# Install the engines at their reviewed versions: ACE-Step 1.5, MuLaCover (gb_generate) and the RoFormer separator (gb_stem). Apple Silicon only.
# Safe to re-run: what is installed is checked, not redone; an interrupted download resumes.
#
#   ./scripts/install-engines.sh ace-step              ACE-Step 1.5 (MIT): code, venv, 10 GB of weights
#   ./scripts/install-engines.sh mulacover             MuLaCover: 15 GB; weights AND outputs non-commercial (CC BY-NC 4.0)
#   ./scripts/install-engines.sh ace-step-base         ACE-Step's base model for lego / complete (MIT): 4.8 GB more
#   ./scripts/install-engines.sh roformer              RoFormer vocal separation for gb_stem (MIT): 0.9 GB
#   ./scripts/install-engines.sh sections              all-in-one song sections for gb_analyze map (MIT): 0.1 GB
#   ./scripts/install-engines.sh all
#   --dry-run                print the plan, change nothing
#   --accept-noncommercial   accept MuLaCover's licence without the question (for scripts)
#
# Needs: macOS on Apple Silicon, git, uv (brew install uv). Folders: GB_MCP_ENGINE_HOME (default
# ~/Library/Caches/gb-mcp). Then restart Claude Code: gb_generate finds the engines there.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
case "${1:-}" in -h|--help|"") sed -n '4,14p' "$0"; exit 0 ;; esac
if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then echo "  ✗ the engines need macOS on Apple Silicon" >&2; exit 1; fi
command -v git >/dev/null 2>&1 || { echo "  ✗ git is required: xcode-select --install" >&2; exit 1; }
cd "${REPO:?}/models"
if [ -x .venv/bin/python ]; then exec .venv/bin/python -m gbmodels.install_engines "$@"; fi
command -v uv >/dev/null 2>&1 || { echo "  ✗ uv is required: brew install uv" >&2; exit 1; }
exec uv run --no-project --python 3.12 python -m gbmodels.install_engines "$@"
