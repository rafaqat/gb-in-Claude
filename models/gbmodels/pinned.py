# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""Third-party code that gb-mcp imports must be the reviewed commit with a clean tree: a changed or tampered checkout
is refused before anything is imported (M12b engines: ACE-Step, MuLaCover)."""
import os
import subprocess


def verify_checkout(path: str, commit: str, label: str, install_hint: str = "") -> None:
    """Raise RuntimeError unless `path` is a git checkout of `commit` with no local changes."""
    if not os.path.isdir(os.path.join(path, ".git")):
        raise RuntimeError(f"{label} is not installed at {path}" + (f" ({install_hint})" if install_hint else ""))
    head = subprocess.run(["git", "-C", path, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    if head != commit:
        raise RuntimeError(f"{label} checkout is {head[:12] or 'unreadable'}, not the reviewed commit {commit[:12]}")
    dirty = subprocess.run(["git", "-C", path, "status", "--porcelain"], capture_output=True, text=True).stdout.strip()
    if dirty:
        raise RuntimeError(f"{label} checkout has local changes; refusing to import it")
