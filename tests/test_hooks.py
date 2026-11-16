"""The hook dispatcher (JP-105): hooks load from josh-360's hooks/ folder."""
from __future__ import annotations

import os
import shutil
import tempfile
import unittest
from pathlib import Path

from helpers import REPO, run


class DispatchTest(unittest.TestCase):

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="josh360-hooks-"))
        self.hooks = self.tmp / "hooks"
        self.hooks.mkdir()
        shutil.copy2(str(REPO / "hooks" / "dispatch"), str(self.hooks / "dispatch"))
        self.env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(self.tmp),
                    "JOSH360_HOME": str(self.tmp / "j360")}

    def tearDown(self):
        shutil.rmtree(str(self.tmp), ignore_errors=True)

    def hook(self, event, name, body):
        folder = self.hooks / event
        folder.mkdir(exist_ok=True)
        path = folder / name
        path.write_text("#!/bin/bash\n" + body + "\n")
        path.chmod(0o755)

    def dispatch(self, event, payload='{"hook_event_name": "x"}'):
        return run([str(self.hooks / "dispatch"), event], self.tmp, self.env, check=False, input_text=payload)

    def log(self):
        path = self.tmp / "j360" / "logs" / "hooks.log"
        return path.read_text() if path.exists() else ""

    def test_no_hooks_is_a_quiet_no_op(self):
        big = '{"x": "' + "a" * 200000 + '"}'  # more than a pipe buffer: stdin is read, not left unread
        result = self.dispatch("PreToolUse", big)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "", ""))

    def test_a_new_hook_file_is_picked_up(self):
        self.hook("SessionStart", "10-hello", 'read -r line; echo "saw ${#line} bytes"')
        self.hook("SessionStart", "20-more", 'echo second')
        result = self.dispatch("SessionStart")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "saw 24 bytes\nsecond\n")

    def test_exit_2_blocks(self):
        self.hook("PreToolUse", "10-guard", 'echo "not allowed" >&2; exit 2')
        self.hook("PreToolUse", "20-never", 'echo should-not-run')
        result = self.dispatch("PreToolUse")
        self.assertEqual(result.returncode, 2)
        self.assertIn("not allowed", result.stderr)
        self.assertNotIn("should-not-run", result.stdout)

    def test_a_broken_hook_fails_open(self):
        self.hook("Stop", "10-broken", 'exit 7')
        self.hook("Stop", "20-fine", 'echo fine')
        result = self.dispatch("Stop")
        self.assertEqual((result.returncode, result.stdout), (0, "fine\n"))
        self.assertIn("10-broken failed (exit 7)", self.log())

    def test_first_json_wins(self):
        self.hook("UserPromptSubmit", "10-a", 'echo \'{"a": 1}\'')
        self.hook("UserPromptSubmit", "20-b", 'echo \'{"b": 2}\'')
        result = self.dispatch("UserPromptSubmit")
        self.assertEqual(result.stdout.strip(), '{"a": 1}')
        self.assertIn("20-b printed JSON after another hook did", self.log())

    def test_files_that_are_not_executable_are_ignored(self):
        folder = self.hooks / "Stop"
        folder.mkdir()
        (folder / "README.md").write_text("notes\n")
        self.assertEqual(self.dispatch("Stop").stdout, "")

    def test_odd_event_names_do_nothing(self):
        for event in ("", "../etc", ".hidden"):
            self.assertEqual(self.dispatch(event).returncode, 0)


if __name__ == "__main__":
    unittest.main()
