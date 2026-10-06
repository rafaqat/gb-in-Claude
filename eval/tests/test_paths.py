# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""eval/_paths.py: the one place the eval scripts find the workspace (code review 2026-10-06, finding 8).
    models/.venv/bin/python -m unittest discover -s eval/tests"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import _paths  # noqa: E402


class Workspace(unittest.TestCase):
    def test_gb_mcp_workspace_wins_and_is_made_absolute(self):
        self.assertEqual(_paths.workspace({"GB_MCP_WORKSPACE": "/tmp/ws"}), "/tmp/ws")
        self.assertEqual(_paths.workspace({"GB_MCP_WORKSPACE": "rel/ws"}), os.path.abspath("rel/ws"))

    def test_unset_or_empty_means_the_out_folder_beside_gb_mcp(self):
        default = os.path.expanduser("~/Music/gb-mcp")
        self.assertEqual(_paths.workspace({}), default)
        self.assertEqual(_paths.workspace({"GB_MCP_WORKSPACE": ""}), default)
        self.assertEqual(_paths.workspace({"GB_MCP_WORKSPACE": "  "}), default)

    def test_root_is_the_gb_mcp_folder(self):
        self.assertTrue(os.path.exists(os.path.join(_paths.ROOT, "package.json")))


if __name__ == "__main__":
    unittest.main()


class OnePlace(unittest.TestCase):
    """Every eval script takes the workspace from _paths (finding 8: 11 copies, and run.py ignored GB_MCP_WORKSPACE)."""

    def test_no_eval_script_builds_its_own_workspace(self):
        eval_dir = os.path.join(_paths.ROOT, "eval")
        own = []
        for d, _, files in os.walk(eval_dir):
            for f in files:
                if f.endswith(".py") and f != "_paths.py" and "tests" not in d:
                    text = open(os.path.join(d, f)).read()
                    if 'environ.get("GB_MCP_WORKSPACE")' in text or 'os.path.join(os.path.dirname(ROOT), "out")' in text:
                        own.append(os.path.relpath(os.path.join(d, f), eval_dir))
        self.assertEqual(own, [])

    def test_run_py_honours_gb_mcp_workspace(self):
        import subprocess
        out = subprocess.run([sys.executable, "-c", "import run; print(run.WORKSPACE)"], cwd=os.path.join(_paths.ROOT, "eval"),
                             env={**os.environ, "GB_MCP_WORKSPACE": "/tmp/gb-ws-test", "PYTHONPATH": os.path.join(_paths.ROOT, "models")},
                             capture_output=True, text=True)
        self.assertEqual(out.stdout.strip(), "/tmp/gb-ws-test", out.stderr[-500:])
