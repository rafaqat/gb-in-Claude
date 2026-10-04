# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""CLaMP 3's code is imported, so it is pinned: the reviewed commit and the hashes of the imported files.
A changed or tampered checkout is refused before anything is imported (supply-chain review, v0.3.1)."""
import os
import shutil
import tempfile
import unittest

from gbmodels import clamp3


@unittest.skipUnless(os.path.isdir(os.path.join(clamp3.CODE, ".git")), "needs the CLaMP 3 checkout")
class Pin(unittest.TestCase):
    def test_the_reviewed_checkout_passes(self):
        clamp3.verify_code(clamp3.CODE)  # raises if not the pinned commit and files

    def test_a_changed_file_is_refused(self):
        with tempfile.TemporaryDirectory() as d:
            copy = os.path.join(d, "clamp3")
            shutil.copytree(clamp3.CODE, copy, ignore=shutil.ignore_patterns("__pycache__"))
            with open(os.path.join(copy, "code", "utils.py"), "a") as f:
                f.write("\n# changed\n")
            with self.assertRaisesRegex(ValueError, "utils.py"):
                clamp3.verify_code(copy)


if __name__ == "__main__":
    unittest.main()
