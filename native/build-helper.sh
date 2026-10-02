#!/bin/bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
# Build gb-helper (release), copy to native/bin/gb-helper, ad-hoc sign with a stable identifier.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/gb-helper"
swift build -c release --product gb-helper >&2
mkdir -p "$here/bin"
cp "$(swift build -c release --show-bin-path)/gb-helper" "$here/bin/gb-helper"
codesign --force --sign - --identifier com.gbmcp.helper "$here/bin/gb-helper"
codesign --display --verbose=1 "$here/bin/gb-helper" 2>&1 | grep -E "^(Identifier|Signature)" >&2
echo "$here/bin/gb-helper"
