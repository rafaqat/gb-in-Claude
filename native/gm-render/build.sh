#!/bin/bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
# Build gm-render (offline DLS General MIDI renderer) into native/bin, ad-hoc signed.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$here/../bin"
xcrun swiftc -O -swift-version 5 "$here/main.swift" -o "$here/../bin/gm-render"
codesign -s - --force --identifier com.gbmcp.gm-render "$here/../bin/gm-render"
echo "built $here/../bin/gm-render"
