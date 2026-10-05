# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""Third-party code the engines import must be the reviewed commit with a clean tree (M12b: ACE-Step, MuLaCover)."""
import os
import subprocess
import tempfile
import unittest

from gbmodels.pinned import verify_checkout


def repo():
    d = tempfile.mkdtemp()
    git = lambda *a: subprocess.run(["git", "-C", d, *a], check=True, capture_output=True, text=True).stdout.strip()
    git("init", "-q")
    open(os.path.join(d, "code.py"), "w").write("x = 1\n")
    git("add", "code.py")
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "one")
    return d, git("rev-parse", "HEAD")


class PinnedCheckout(unittest.TestCase):
    def test_the_reviewed_commit_with_a_clean_tree_passes(self):
        d, head = repo()
        verify_checkout(d, head, "Engine")

    def test_another_commit_is_refused(self):
        d, _ = repo()
        with self.assertRaisesRegex(RuntimeError, "Engine checkout is .* not the reviewed commit 0000000000"):
            verify_checkout(d, "0" * 40, "Engine")

    def test_local_changes_are_refused(self):
        d, head = repo()
        open(os.path.join(d, "code.py"), "a").write("y = 2\n")
        with self.assertRaisesRegex(RuntimeError, "local changes"):
            verify_checkout(d, head, "Engine")

    def test_a_missing_checkout_says_how_to_get_it(self):
        with self.assertRaisesRegex(RuntimeError, "not installed"):
            verify_checkout("/nonexistent/engine", "0" * 40, "Engine", install_hint="see the generate guide")


if __name__ == "__main__":
    unittest.main()
