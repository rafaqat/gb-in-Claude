# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""scripts/install-engines.sh (gbmodels.install_engines): what is installed is checked, what is missing is planned in
order (code → venv → weights), a wrong or changed checkout stops the install, and MuLaCover needs its licence accepted.
No test downloads anything."""
import io
import os
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout

from gbmodels import ace_step, mulacover
from gbmodels import install_engines as ie


def repo():
    d = tempfile.mkdtemp()
    git = lambda *a: subprocess.run(["git", "-C", d, *a], check=True, capture_output=True, text=True).stdout.strip()
    git("init", "-q")
    open(os.path.join(d, "a.py"), "w").write("x = 1\n")
    git("add", "a.py")
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "one")
    return d, git("rev-parse", "HEAD")


class States(unittest.TestCase):
    def test_code_state(self):
        d, head = repo()
        self.assertEqual(ie.code_state("/nonexistent/x", head)[0], "missing")
        self.assertEqual(ie.code_state(d, head)[0], "ok")
        self.assertEqual(ie.code_state(d, "0" * 40)[0], "wrong_commit")
        open(os.path.join(d, "a.py"), "a").write("y = 2\n")
        self.assertEqual(ie.code_state(d, head)[0], "dirty")

    def test_weights_state(self):
        d = tempfile.mkdtemp()
        self.assertEqual(ie.weights_state(os.path.join(d, "none")), "missing")
        open(os.path.join(d, "model.safetensors"), "wb").write(b"x")
        self.assertEqual(ie.weights_state(d), "ok")
        os.makedirs(os.path.join(d, ".cache", "huggingface", "download"))
        open(os.path.join(d, ".cache", "huggingface", "download", "model.safetensors.incomplete"), "wb").close()
        self.assertEqual(ie.weights_state(d), "partial")


class Plans(unittest.TestCase):
    def test_the_pins_come_from_the_engine_modules(self):
        self.assertEqual(ie.ENGINES["ace-step"]["commit"], ace_step.PINNED_COMMIT)
        self.assertEqual(ie.ENGINES["mulacover"]["commit"], mulacover.PINNED_COMMIT)
        self.assertEqual([w[1] for w in ie.ENGINES["mulacover"]["weights"]], [r for _, r in mulacover.WEIGHTS.values()])

    def test_a_fresh_engine_is_cloned_then_given_a_venv_then_its_weights(self):
        steps = ie.plan("ace-step", {"code": ("missing", ""), "venv": "missing", "weights": ["missing"]})
        kinds = [s.kind for s in steps]
        self.assertEqual(kinds[:3], ["clone", "venv", "weights"])

    def test_an_installed_engine_is_only_checked(self):
        steps = ie.plan("mulacover", {"code": ("ok", ""), "venv": "ok", "weights": ["ok", "ok", "ok"]})
        self.assertEqual({s.kind for s in steps}, {"check"})

    def test_a_wrong_or_changed_checkout_stops_the_install(self):
        with self.assertRaisesRegex(ie.InstallError, "not the reviewed commit"):
            ie.plan("ace-step", {"code": ("wrong_commit", "abc123"), "venv": "ok", "weights": ["ok"]})
        with self.assertRaisesRegex(ie.InstallError, "local changes"):
            ie.plan("ace-step", {"code": ("dirty", ""), "venv": "ok", "weights": ["ok"]})


class Licence(unittest.TestCase):
    def test_mulacover_needs_its_licence_accepted(self):
        with self.assertRaisesRegex(ie.InstallError, "--accept-noncommercial"):
            ie.licence_ok("mulacover", accepted=False, ask=None)  # no terminal to ask in
        self.assertTrue(ie.licence_ok("mulacover", accepted=True, ask=None))
        self.assertTrue(ie.licence_ok("mulacover", accepted=False, ask=lambda prompt: "yes"))
        with self.assertRaises(ie.InstallError):
            ie.licence_ok("mulacover", accepted=False, ask=lambda prompt: "no")
        self.assertTrue(ie.licence_ok("ace-step", accepted=False, ask=None))  # MIT: nothing to accept


class DryRun(unittest.TestCase):
    def test_dry_run_prints_the_plan_and_runs_nothing(self):
        home = tempfile.mkdtemp()
        ran = []
        out = io.StringIO()
        with redirect_stdout(out):
            code = ie.main(["ace-step", "--dry-run"], env={"GB_MCP_ENGINE_HOME": home}, run=lambda argv, **k: ran.append(argv))
        self.assertEqual(code, 0)
        self.assertEqual(ran, [])
        self.assertIn("clone", out.getvalue())
        self.assertIn(ace_step.PINNED_COMMIT[:7], out.getvalue())
        self.assertFalse(os.listdir(home))


if __name__ == "__main__":
    unittest.main()
