#!/bin/bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
# Rebuild models/locks/<venv>.lock from what is installed and tested (security review E2): every package from the
# index at its installed version, with the SHA-256 of each of its files (Apple Silicon, macOS 14+, Python 3.12).
#   scripts/lock-models.sh sidecar | mulacover | roformer | sections
# Run the suites with the new lock installed before committing it. Git sources and the engine's own checkout stay
# out of the lock (they are pinned by commit and installed with --no-deps).
set -euo pipefail
name=${1:?usage: lock-models.sh sidecar|mulacover|roformer|sections}
root=$(cd "$(dirname "$0")/.." && pwd)
home=${GB_MCP_ENGINE_HOME:-$HOME/Library/Caches/gb-mcp}
case "$name" in
  sidecar) py="$root/models/.venv/bin/python"; skip=(anticipation beat-this) ;;
  mulacover|roformer) py="$home/$name/.venv/bin/python"; skip=() ;;
  sections) py="$home/sections/.venv/bin/python"; skip=(madmom natten) ;;
  *) echo "unknown venv: $name" >&2; exit 2 ;;
esac
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
uv pip freeze --python "$py" | grep -v '^-e ' > "$tmp/in.txt"
args=(--generate-hashes --python-version 3.12 --python-platform aarch64-apple-darwin --no-header --no-annotate -q)
for p in ${skip[@]+"${skip[@]}"}; do args+=(--no-emit-package "$p"); done
src="$tmp/in.txt"; extra=()
if [ "$name" = sidecar ]; then src="$root/models/requirements.txt"; extra=(-c "$tmp/in.txt"); fi
MACOSX_DEPLOYMENT_TARGET=14.0 uv pip compile "$src" ${extra[@]+"${extra[@]}"} "${args[@]}" -o "$tmp/out.lock"
out="$root/models/locks/$name.lock"
{ echo "# gb-mcp $name venv: every package from the index at the version tested on Apple Silicon, with its SHA-256."
  echo "# Install: uv pip install --require-hashes --no-deps -r models/locks/$name.lock (scripts/lock-models.sh rebuilds it)."
  cat "$tmp/out.lock"; } > "$out.new"
mv "$out.new" "$out"
echo "wrote $out"
# <venv>-build.lock: the build tools from the same lock (same versions, same hashes), installed first so a package
# without a wheel builds with --no-build-isolation from checked files, never with tools fetched from the index.
build="$root/models/locks/$name-build.lock"
{ echo "# gb-mcp $name venv, build tools: the same pins and hashes as $name.lock, installed before it."
  echo "# Install: uv pip install --require-hashes --no-deps -r models/locks/$name-build.lock"
  python3 - "$out" <<'PY'
import re, sys
blocks = [b.rstrip("\n") for b in re.split(r"\n(?=[a-z0-9])", open(sys.argv[1]).read()) if b[:1].isalnum()]
print("\n".join(b for b in blocks if b.split("==")[0] in ("setuptools", "wheel", "cython", "numpy")))
PY
} > "$build.new"
mv "$build.new" "$build"
echo "wrote $build"
