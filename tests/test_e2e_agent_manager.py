"""JP-186: the binding against the REAL Agent Manager (the laptop's version), with a stand-in `claude` and no model.

These need the pinned Agent Manager and tmux 3.1+. Without them every test here is skipped, with the command that
installs it (`python3 tests/e2e/agent_manager.py install`); with JOSH360_E2E_AM=1 a missing install fails instead.
Each test makes its own Agent Manager home and tmux servers in a temporary folder, and stops them after.
"""
import json
import os
import shutil
import sys
import time
import unittest

from runner_helpers import ROOT, RunnerCase

sys.path.insert(0, str(ROOT / "tests" / "e2e"))
import agent_manager  # noqa: E402
import binding  # noqa: E402
from runner_lib import hooklib  # noqa: E402

AM = agent_manager.installed()
TOOLS = agent_manager.missing_tools()
REQUIRED = os.environ.get("JOSH360_E2E_AM") == "1"
WHY = "the real Agent Manager {} is not here ({}): python3 tests/e2e/agent_manager.py install".format(
    agent_manager.PINNED, "; ".join(TOOLS) or "not installed")
LAPTOP_REFUSAL = 'model "claude-sonnet-5-5" is not one claude lists; it lists default, opus, fable, sonnet, haiku'


class RealAgentManagerCase(RunnerCase):
    start_manager = True

    def setUp(self):
        if not AM or TOOLS:
            if REQUIRED:
                self.fail(WHY)
            self.skipTest(WHY)
        super().setUp()
        shutil.copy(str(ROOT / "graphs" / "tiers.yaml"), str(self.root / "tiers.yaml"))   # real model names
        self.compile()
        self.am = agent_manager.Instance(self.tmp / "am", AM).setup()
        self.addCleanup(self.am.stop)
        os.environ.update(self.am.env())
        self.am.plan("example")
        if self.start_manager:
            self.am.start_manager()

    def answer(self, model="claude-sonnet-5-5", effort="medium"):
        run = self.start("valid", "JP-901")
        a = self.walker("next", "--run", run)
        self.assertEqual(a["action"], "run", a)
        a["models"] = [{"model": model, "effort": effort}]
        return a

    def marker(self, a):
        return hooklib.marker(a["run"], a["step"], a["attempt"], "0123456789abcdef")

    def watch(self, handle, until, timeout=30.0):
        """binding.state and the raw database status every quarter second, until `until` (a binding word)."""
        seen, raw = [], []
        deadline = time.time() + timeout
        while time.time() < deadline:
            word = binding.state(handle)
            row = self.am.row(handle["am_session"]) or {}
            for into, value in ((seen, word), (raw, row.get("status"))):
                if not into or into[-1] != value:
                    into.append(value)
            if word == until:
                break
            time.sleep(0.25)
        return seen, raw


class StepSession(RealAgentManagerCase):
    """Scenario: A step session runs and rests."""

    def test_state_reads_working_then_resting_within_30_seconds(self):
        a = self.answer()
        handle = binding.start(a, self.marker(a), "")
        self.assertEqual(handle["model"], "opus")                     # binding.json's map, as on the laptop
        seen, raw = self.watch(handle, "resting")
        self.assertEqual(seen[-1], "resting", (seen, raw))
        self.assertIn("working", seen)
        self.assertLess(seen.index("working"), seen.index("resting"))
        self.assertIn("working", raw, raw)                            # the stand-in's hooks moved it, not `starting`
        self.assertIn(raw[-1], ("idle", "finished"), raw)
        with open(a["result_file"]) as f:
            result = json.load(f)
        self.assertIn(result["outcome"], a["outcomes"])
        spawned = self.am.standin_events("session")
        self.assertEqual(len(spawned), 1)
        self.assertEqual(spawned[0]["am_session"], handle["am_session"])
        self.assertEqual((spawned[0]["model"], spawned[0]["effort"]), ("opus", "medium"))

    def test_move_and_close_change_the_group_and_archived_flag(self):
        a = self.answer()
        handle = binding.start(a, self.marker(a), "")
        self.assertEqual(binding.placed(handle), ("josh-360/graph-runs", False))
        self.watch(handle, "resting")
        self.assertTrue(binding.move(handle, "josh-360/tickets/In Progress"))
        self.assertEqual(binding.placed(handle), ("josh-360/tickets/In Progress", False))
        self.assertTrue(binding.close(handle))
        self.assertEqual(binding.placed(handle), ("josh-360/tickets/In Progress", True))
        self.assertEqual(binding.state(handle), "gone")
        made = [c["argv"][1] for c in self.am.calls("create-group") if c["code"] == 0]
        self.assertEqual(made, ["josh-360", "josh-360/graph-runs", "josh-360/tickets", "josh-360/tickets/In Progress"])
        groups = {g["path"] if isinstance(g, dict) else g for g in self.am.snapshot()["groups"]}
        self.assertIn("josh-360/tickets/In Progress", groups)


class RefusedModel(RealAgentManagerCase):
    """Scenario: A model Agent Manager does not list is refused."""

    def empty_map(self):
        doc = binding.config()
        doc["models"] = {}
        path = self.tmp / "binding-empty-models.json"
        path.write_text(json.dumps(doc))
        os.environ["JOSH360_AM_BINDING_JSON"] = str(path)

    def test_empty_models_map_is_refused_with_agent_managers_message(self):
        self.empty_map()
        a = self.answer()
        with self.assertRaises(binding.SpawnRefused) as caught:
            binding.start(a, self.marker(a), "")
        self.assertEqual(str(caught.exception), "bad-model")           # JP-183's reason code
        self.assertIn(LAPTOP_REFUSAL, caught.exception.detail)         # and Agent Manager's own words
        spawns = self.am.calls("spawn")
        self.assertEqual(len(spawns), 1)
        self.assertNotEqual(spawns[0]["code"], 0)
        self.assertIn(LAPTOP_REFUSAL, spawns[0]["stderr"])
        self.assertEqual(self.am.standin_events("session"), [])        # nothing was started

    def test_an_effort_the_model_does_not_take_is_refused(self):
        a = self.answer(effort="turbo")
        with self.assertRaises(binding.SpawnRefused) as caught:
            binding.start(a, self.marker(a), "")
        self.assertEqual(str(caught.exception), "bad-effort")
        self.assertIn('effort "turbo" is not one opus takes', self.am.calls("spawn")[0]["stderr"])


class Rails(RealAgentManagerCase):
    """Scenario: The rails see the stand-in's hooks."""

    def test_the_session_gets_a_graph_sessions_entry_linking_it_to_its_run(self):
        self.am.rails(ROOT)
        run = self.start("valid", "JP-901")
        doc = self.fake_spawn(run)
        am_session = doc["handle"]["am_session"]
        conversation = None
        deadline = time.time() + 30
        while time.time() < deadline:
            row = self.am.row(am_session) or {}
            conversation = row.get("agent_session_id")
            if conversation and hooklib.entry(conversation):
                break
            time.sleep(0.25)
        entry = hooklib.entry(conversation)
        self.assertIsNotNone(entry, self.am.standin_events("hook"))
        self.assertEqual((entry["run"], entry["step"], entry["attempt"]), (run, doc["step"], doc["attempt"]))
        self.assertEqual(entry["am_session"], am_session)
        def dispatched():           # the stand-in logs a hook once it returns, just after the entry is written
            return [e for e in self.am.standin_events("hook")
                    if e["event"] == "UserPromptSubmit" and "hooks/dispatch UserPromptSubmit" in e["command"]]
        deadline = time.time() + 10
        while not dispatched() and time.time() < deadline:
            time.sleep(0.25)
        self.assertEqual([e["code"] for e in dispatched()], [0])
        # Agent Manager puts its own note before the runner's marker, so the marker is not the prompt's first line
        typed = self.am.standin_events("session")[0]["argv"]
        text = next(w for w in typed if "[josh360-step" in w)
        self.assertFalse(text.startswith("[josh360-step"))


class ManagerDown(RealAgentManagerCase):
    """Scenario: The manager is not running."""

    start_manager = False

    def test_status_stays_starting_and_the_harness_says_why(self):
        self.assertFalse(self.am.manager_running())
        a = self.answer()
        handle = binding.start(a, self.marker(a), "")
        with self.assertRaises(agent_manager.ManagerNotRunning) as caught:
            self.am.wait_status(handle["am_session"], ("working", "idle", "finished"), timeout=8)
        self.assertIn("manager is not running", str(caught.exception))
        self.assertEqual(self.am.row(handle["am_session"])["status"], "starting")
        report = self.am.check()
        self.assertFalse(report["manager_running"])
        self.assertIn(agent_manager.NOT_RUNNING, report["problems"])


if __name__ == "__main__":
    unittest.main()
