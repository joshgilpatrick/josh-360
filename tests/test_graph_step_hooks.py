"""JP-117, Tasks 6 to 8: the four hooks that put the rails on a graph step's session, and on no other session."""
import json
import os
import subprocess
import unittest
from pathlib import Path
from unittest import mock

from runner_helpers import ROOT, RunnerCase
from runner_lib import hooklib, sessionfile

OK = (0, "", "")


class Linking(RunnerCase):
    def setUp(self):
        super().setUp()
        self.run_id = self.start("valid", "JP-901")
        self.session = self.fake_spawn(self.run_id)

    def link(self, prompt, session_id="cc-1", **env):
        return hooklib.link({"session_id": session_id, "prompt": prompt}, dict({"AGENT_MANAGER_SESSION_ID": "s-1"}, **env),
                            self.now)

    def prompt(self):
        return self.logged_prompt(self.run_id, "design")

    def entry_file(self, sid="cc-1"):
        from ledger import graph_sessions
        return graph_sessions.entry_path(sid)

    def test_first_prompt_with_the_marker_links_the_session(self):
        entry = self.session_starts(self.run_id, "design")
        for key in ("run", "step", "attempt", "access", "outcomes", "result_file", "work_dir"):
            self.assertEqual(entry[key], self.session[key], key)
        self.assertEqual((entry["am_session"], entry["nudged_at"], entry["started_at"]), ("s-1", None, self.now))
        link = sessionfile.read_link(self.run_id, "design", 1)
        self.assertEqual(link["session_id"], "cc-1")

    def test_marker_may_follow_text_agent_manager_adds(self):
        self.assertEqual(self.link("some preamble\nmore text\n" + self.prompt()), OK)
        self.assertTrue(self.entry_file().is_file())

    def test_wrong_key_does_not_link(self):
        bad = self.prompt().replace("key=0123456789abcdef", "key=ffffffffffffffff")
        self.assertEqual(self.link(bad), OK)
        self.assertFalse(self.entry_file().exists())

    def test_marker_for_a_recorded_step_does_not_link(self):
        doc = sessionfile.read(self.run_id, "design", 1)
        sessionfile.write(self.run_id, "design", 1, dict(doc, state="recorded"))
        self.assertEqual(self.link(self.prompt()), OK)
        self.assertFalse(self.entry_file().exists())

    def test_second_session_with_the_same_marker_does_not_link(self):
        self.session_starts(self.run_id, "design")
        self.assertEqual(self.link(self.prompt(), session_id="cc-2"), OK)
        self.assertFalse(self.entry_file("cc-2").exists())

    def test_unknown_run_does_not_link(self):
        bad = self.prompt().replace(self.run_id, "r-ffffffffffff")
        self.assertEqual(self.link(bad), OK)
        self.assertFalse(self.entry_file().exists())

    def test_ordinary_prompt_is_untouched(self):
        os.environ["JOSH360_RUNS"] = str(self.tmp / "no-runs-here")
        with mock.patch.object(sessionfile, "read", side_effect=AssertionError("read a run folder")):
            self.assertEqual(self.link("Please fix the build. [josh360-step is only a phrase]"), OK)
        self.assertFalse((self.tmp / "no-runs-here").exists())

    def test_hook_file_runs_through_the_dispatcher(self):
        payload = json.dumps({"session_id": "cc-1", "hook_event_name": "UserPromptSubmit", "prompt": self.prompt()})
        env = dict(os.environ, AGENT_MANAGER_SESSION_ID="s-1")
        done = subprocess.run([str(ROOT / "hooks" / "dispatch"), "UserPromptSubmit"], input=payload,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, env=env)
        self.assertEqual((done.returncode, done.stdout), (0, ""), done.stderr)
        self.assertTrue(self.entry_file().is_file())


if __name__ == "__main__":
    unittest.main()
