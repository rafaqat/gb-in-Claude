#!/bin/bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
# Builds a miniature GarageBand patch library (same layout as GarageBand.app/Contents/Resources/Patches).
set -euo pipefail
cd "$(dirname "$0")"
rm -rf patches && mkdir -p patches
meta() { # meta <patch dir> <pack>...  → com.apple.musicapps.metadata.plist (binary, via plutil)
  local dir="$1"; shift
  local items=""; for p in "$@"; do items+="<string>$p</string>"; done
  printf '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>PackageNames</key><array>%s</array></dict></plist>' "$items" > "$dir/m.xml"
  plutil -convert binary1 -o "$dir/com.apple.musicapps.metadata.plist" "$dir/m.xml"; rm "$dir/m.xml"
}
patch() { mkdir -p "patches/$1"; touch "patches/$1/#Root.cst"; }
patch "factory/Instrument/Synthesizer/Bass/Taureg Moon Bass.patch"
patch "factory/Instrument/Synthesizer/Lead/Soft Saw Lead.patch"
patch "factory/Instrument/Electronic Drum Kit/Epic Electro GB.patch";   meta "patches/factory/Instrument/Electronic Drum Kit/Epic Electro GB.patch" "Hardwell"
patch "factory/Instrument/z01 Arpeggiator/Synth Basics/Pulse Arp.patch"; meta "patches/factory/Instrument/z01 Arpeggiator/Synth Basics/Pulse Arp.patch" "Watch the Sound"
patch "factory/Audio/04 Voice/Natural Vocal.patch"
patch "factory/Output/Master Track.patch"
patch "user/Instrument/My Lead.patch"
mkdir -p "patches/outside"
ln -s "$(pwd)/patches/outside" "patches/factory/Instrument/Escape.patch"   # symlinked patch: must be skipped
