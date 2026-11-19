"""JP-171: the walker gives gate scripts the Jira email from the same place every Jira reader on the laptop finds it
(the environment, then ~/.josh-360/state/jira-email). Made-up addresses and tokens only; no network."""
import json
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from walker_helpers import ROOT, WalkerCase  # noqa: E402
from walker_lib import gates  # noqa: E402

FILE_EMAIL = "made.up.file@example.invalid"
ENV_EMAIL = "made.up.env@example.invalid"

# An entry gate that builds the real gate Jira client, the way every Jira-reading gate does, and logs what it got.
JIRA_GATE = """#!/usr/bin/env python3
import json, os, sys
sys.path.insert(0, %r)
from lib import jira
client = jira.Jira.from_env()
with open(os.environ["WALKER_TEST_LOG"], "a") as f:
    f.write(json.dumps({"gate": "ready", "email": os.environ.get("JOSH360_JIRA_EMAIL"),
                        "client": type(client).__name__}) + "\\n")
print(json.dumps({"outcome": "pass"}))
""" % (str(ROOT / "graphs" / "gates"),)


def never(*args, **kwargs):
    raise AssertionError("the keychain was asked although the token is in the environment")


class GateJiraEnvTest(WalkerCase):
    def setUp(self):
        super().setUp()
        os.environ.pop("JOSH360_JIRA_FAKE", None)
        os.environ["JOSH360_JIRA_TOKEN"] = "made-up-token"
        self.state = Path(os.environ["JOSH360_HOME"]) / "state"
        (self.state / "jira-email").write_text(FILE_EMAIL + "\n")

    def test_the_email_is_only_in_the_state_file(self):
        """Scenario: The email is only in the state file."""
        (self.root / "gates" / "ready.py").write_text(JIRA_GATE)
        run = self.start()
        self.assertTrue(run)
        got = [line for line in self.log() if line.get("gate") == "ready"]
        self.assertEqual(got, [{"gate": "ready", "email": FILE_EMAIL, "client": "Jira"}])

    def test_the_environment_still_wins(self):
        """Scenario: The environment still wins."""
        env = gates.jira_env({"JOSH360_JIRA_EMAIL": ENV_EMAIL, "JOSH360_JIRA_TOKEN": "t"}, run=never, state=self.state)
        self.assertEqual(env["JOSH360_JIRA_EMAIL"], ENV_EMAIL)
        env = gates.jira_env({"ACTION_AGENT_JIRA_EMAIL": ENV_EMAIL, "JOSH360_JIRA_TOKEN": "t"}, run=never,
                             state=self.state)
        self.assertEqual(env["JOSH360_JIRA_EMAIL"], ENV_EMAIL)
        self.assertEqual(gates.gate_env({}, [], "r1", "/runs", None, None)["JOSH360_JIRA_EMAIL"], FILE_EMAIL)

    def test_a_missing_half_is_left_out_not_invented(self):
        (self.state / "jira-email").unlink()

        def no_item(argv, **kwargs):
            return type("Done", (), {"returncode": 44, "stdout": ""})()
        self.assertEqual(gates.jira_env({}, run=no_item, state=self.state), {})
        self.assertEqual(gates.jira_env({"JOSH360_JIRA_TOKEN": "t"}, run=never, state=self.state),
                         {"JOSH360_JIRA_TOKEN": "t"})

    def test_the_token_comes_from_the_keychain_item_by_name(self):
        asked = []

        def keychain(argv, **kwargs):
            asked.append(list(argv))
            return type("Done", (), {"returncode": 0, "stdout": "made-up-keychain-token\n"})()
        env = gates.jira_env({}, run=keychain, state=self.state)
        self.assertEqual(env, {"JOSH360_JIRA_EMAIL": FILE_EMAIL, "JOSH360_JIRA_TOKEN": "made-up-keychain-token"})
        self.assertEqual(len(asked), 1)
        self.assertIn("jira-claude-api-key", asked[0])


if __name__ == "__main__":
    unittest.main()
