#!/bin/bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
# Regenerates binary plist fixtures from inline XML using Apple's plutil (the same encoder GarageBand's files use).
set -euo pipefail
cd "$(dirname "$0")"
cat > metadata.xml <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>PackageNames</key><array><string>Hardwell</string><string>Ultimate 808s</string></array></dict></plist>
XML
cat > mixed.xml <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>name</key><string>Café ♯ Lead</string>
  <key>small</key><integer>7</integer>
  <key>big</key><integer>40014</integer>
  <key>negative</key><integer>-1</integer>
  <key>ratio</key><real>0.5</real>
  <key>on</key><true/>
  <key>off</key><false/>
  <key>nested</key><dict><key>list</key><array><integer>1</integer><string>two</string></array></dict>
</dict></plist>
XML
for f in metadata mixed; do plutil -convert binary1 -o "$f.bplist" "$f.xml"; rm "$f.xml"; done
