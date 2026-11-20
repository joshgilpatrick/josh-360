"""JP-190: a folder fake Jira that holds credentials.json lets in only a client that found that email and token, so a
cloud run trips where the laptop trips when the email is only in ~/.josh-360/state/jira-email (JP-171).

Made-up addresses and tokens only; nothing here reaches a network.

Run: python3 -m unittest discover -s graphs/tests   (from the repository root)
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GATES = ROOT / "graphs" / "gates"
sys.path.insert(0, str(GATES))
sys.path.insert(0, str(ROOT / "graphs" / "runner"))
sys.path.insert(0, str(ROOT))

from lib import jira_fake, jira_strict  # noqa: E402
from lib.jira import Jira  # noqa: E402

KEY = "JP-9116"
EMAIL, TOKEN = "made.up@example.invalid", "made-up-token"


class Credentials(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.folder = Path(self._tmp.name) / "jira"
        jira_strict.install(self.folder, fixtures=(KEY,))

    def lock(self):
        (self.folder / jira_fake.CREDENTIALS).write_text(json.dumps({"email": EMAIL, "token": TOKEN}))

    def calls(self):
        return [json.loads(line) for line in (self.folder / jira_fake.CALLS).read_text().splitlines()]

    def client_in_a_process(self, env):
        """`Jira.from_env` in its own process, as a gate script builds it: (exit code, stderr)."""
        code = ("import sys; sys.path.insert(0, {!r}); from lib.jira import Jira; "
                "c = Jira.from_env(); print(c.get({!r}) is not None)").format(str(GATES), KEY)
        done = subprocess.run([sys.executable, "-c", code], env=dict(env, JOSH360_JIRA_FAKE=str(self.folder)),
                              capture_output=True, text=True)
        return done.returncode, done.stdout.strip(), done.stderr

    def test_without_the_file_any_client_is_let_in(self):
        self.assertIsNone(jira_fake.credentials(self.folder))
        code, out, _ = self.client_in_a_process({})
        self.assertEqual((code, out), (0, "True"))

    def test_a_client_without_the_email_stops_as_the_real_one_does(self):
        self.lock()
        code, _, err = self.client_in_a_process({"JOSH360_JIRA_TOKEN": TOKEN})
        self.assertNotEqual(code, 0)
        self.assertIn("Jira credentials missing", err)

    def test_a_client_with_both_halves_is_let_in(self):
        self.lock()
        code, out, _ = self.client_in_a_process({"JOSH360_JIRA_EMAIL": EMAIL, "JOSH360_JIRA_TOKEN": TOKEN})
        self.assertEqual((code, out), (0, "True"))

    def test_wrong_credentials_get_the_real_401(self):
        self.lock()
        status, body, _ = jira_fake.FileTransport(self.folder)("GET", "https://eventuswh-analytics.atlassian.net"
                                                                "/rest/api/3/issue/" + KEY, {}, None)
        self.assertEqual(status, 401)
        self.assertIn("authenticated", json.loads(body)["errorMessages"][0])
        self.assertEqual(self.calls()[-1]["status"], 401)
        right = Jira("https://eventuswh-analytics.atlassian.net", EMAIL, TOKEN,
                     transport=jira_fake.FileTransport(self.folder), sleep=lambda s: None)
        self.assertIsNotNone(right.get(KEY))

    def test_a_local_site_reaches_the_same_fake(self):
        """The recorder's site may point at a local stand-in; the gates' client still reads the fake by its path."""
        jira = Jira("http://127.0.0.1:9", "a@b.c", "t", transport=jira_fake.FileTransport(self.folder),
                    sleep=lambda s: None)
        self.assertEqual(jira.get(KEY)["key"], KEY)
        self.assertTrue(self.calls()[-1]["path"].startswith("/rest/api/"))

    def test_the_runner_finds_the_email_in_the_state_file_for_a_locked_fake(self):
        from runner_lib import watch
        self.lock()
        state = Path(self._tmp.name) / "home" / ".josh-360" / "state"
        state.mkdir(parents=True)
        (state / "jira-email").write_text(EMAIL + "\n")
        env = {"JOSH360_JIRA_FAKE": str(self.folder), "JOSH360_JIRA_TOKEN": TOKEN,
               "JOSH360_HOME": str(state.parent), "HOME": str(state.parent.parent)}
        from unittest import mock
        with mock.patch.dict("os.environ", env, clear=False):
            client = watch.jira_client(env)
        self.assertIsNotNone(client)
        self.assertIsNotNone(client.get(KEY))


if __name__ == "__main__":
    unittest.main()
