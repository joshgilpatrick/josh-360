"""JP-111: the two Session Atlas hooks load through the dispatcher. Made-up commands in a temp home; nothing real is read."""
from __future__ import annotations

import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

from helpers import REPO, run


class AtlasHooks(unittest.TestCase):

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="josh360-atlas-hooks-"))
        self.j360 = self.tmp / "j360"
        self.env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(self.tmp), "JOSH360_HOME": str(self.j360)}

    def tearDown(self):
        shutil.rmtree(str(self.tmp), ignore_errors=True)

    def dispatch(self, event, payload):
        return run([str(REPO / "hooks" / "dispatch"), event], self.tmp, self.env, check=False,
                   input_text=json.dumps(payload))

    def bash(self, command):
        return {"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": command},
                "cwd": str(self.tmp), "session_id": "sess-0001"}

    def test_the_guard_ignores_other_tools(self):
        r = self.dispatch("PreToolUse", {"hook_event_name": "PreToolUse", "tool_name": "Read",
                                         "tool_input": {"file_path": "git worktree remove --force x"}})
        self.assertEqual((r.returncode, r.stdout, r.stderr), (0, "", ""))

    def test_the_guard_lets_an_ordinary_command_through(self):
        r = self.dispatch("PreToolUse", self.bash("ls -la"))
        self.assertEqual((r.returncode, r.stdout, r.stderr), (0, "", ""))

    def test_the_guard_blocks_a_forced_worktree_removal(self):
        r = self.dispatch("PreToolUse", self.bash("git worktree remove --force /somewhere/else"))
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertTrue(r.stderr.strip())

    def test_the_jira_hook_is_quiet_and_ignores_other_commands(self):
        r = self.dispatch("PostToolUse", {"hook_event_name": "PostToolUse", "tool_name": "Bash",
                                          "tool_input": {"command": "ls"}, "tool_response": {}})
        self.assertEqual((r.returncode, r.stdout, r.stderr), (0, "", ""))
        self.assertFalse((self.j360 / "state" / "cache.db").exists())

    def test_the_jira_hook_writes_to_cache_db_and_never_fails(self):
        r = self.dispatch("PostToolUse", {"hook_event_name": "PostToolUse", "tool_name": "Bash", "session_id": "sess-0001",
                                          "tool_input": {"command": "jira workitem comment create --key JP-1 --body x"},
                                          "tool_response": {"exitCode": 0}})
        self.assertEqual((r.returncode, r.stdout), (0, ""))
        self.assertTrue((self.j360 / "state" / "cache.db").exists())
        self.assertFalse((self.tmp / ".claude" / "cost-ledger").exists())


if __name__ == "__main__":
    unittest.main()
