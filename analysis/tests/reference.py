# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""Reference measurements from ffmpeg's ebur128 filter (the golden meter)."""
import re
import shutil
import subprocess

FFMPEG = shutil.which("ffmpeg")


def ffmpeg_ebur128(path):
    """Return (integrated LUFS, true peak dBFS) as measured by ffmpeg ebur128=peak=true."""
    out = subprocess.run([FFMPEG, "-hide_banner", "-nostats", "-i", str(path), "-af", "ebur128=peak=true", "-f", "null", "-"],
                         capture_output=True, text=True, timeout=300).stderr
    summary = out[out.rindex("Summary:"):]
    integrated = float(re.search(r"I:\s+(-?[\d.]+) LUFS", summary).group(1))
    peak = re.search(r"True peak:\s+Peak:\s+(-?[\d.]+|-inf) dBFS", summary).group(1)
    return integrated, float(peak)
