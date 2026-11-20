"""JP-195: a limit question names what stopped the run: a step at its run cap, a loop at its limit, or the outcome the
ask's own `when` names. Drives the walker's engine on the real triage graph with made-up outcomes; no ledger, no Jira."""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "graphs" / "tools"))
from walker_lib import engine, graphfile, runner  # noqa: E402

OLD_CLAIM = "gaps are on the ticket"


class FakeRun:
    """What `_ask_text` and `limit_reason` read from a run: the graph, the replayed state, the values, the folder."""

    def __init__(self, g, st):
        self.graph, self.state, self.doc = g, st, {}
        self.values = {"ticket_key": "JP-9116"}


def walk(g, st, outcomes):
    queue = {k: list(v) for k, v in outcomes.items()}
    while True:
        act = engine.decide(g, st)
        if act.kind != "run" and act.kind != "gate" or not queue.get(act.step):
            return act
        engine.begin(g, st, act.step, allowed=act.allowed)
        engine.finish(g, st, act.step, queue[act.step].pop(0))


class LimitReason(unittest.TestCase):
    def setUp(self):
        self.g, self.st = graphfile.load("triage", live_check=False), engine.State()
        self.st.entered = True

    def text(self):
        return runner._ask_text(FakeRun(self.g, self.st), "ask_at_limit")

    def test_a_run_cap_names_the_step_its_runs_and_its_cap_plus_the_runs_josh_allowed(self):
        self.st.runs["revise"], self.st.consumed["revise"] = 5, 2
        self.st.forced = engine.Forced("ask_at_limit", "cap", "apply_revision", "applied", ("revise",))
        text = self.text()
        self.assertIn("`revise` has run 5 times against a cap of 3 plus 2 you allowed", text)
        self.assertNotIn(OLD_CLAIM, text)

    def test_a_cap_from_an_older_run_names_the_step_at_its_cap(self):
        self.st.runs["revise"] = 3          # the older walker recorded no step on the forced ask
        self.st.forced = engine.Forced("ask_at_limit", "cap", "apply_revision", "applied")
        self.assertIn("`revise` has run 3 times against a cap of 3,", self.text())

    def test_a_loop_limit_names_both_steps_and_the_limit(self):
        self.st.loops[("apply_revision", "read_ticket")] = 2
        walk(self.g, self.st, {"read_ticket": ["read"], "ready_check": ["gaps"], "verdict": ["revise"],
                               "revise": ["revised"]})
        engine.begin(self.g, self.st, "apply_revision")
        engine.finish(self.g, self.st, "apply_revision", "applied")
        act = engine.decide(self.g, self.st)
        self.assertEqual((act.step, act.forced.reason), ("ask_at_limit", "loop"))
        self.assertIn("from `apply_revision` back to `read_ticket` 2 times, the most this graph allows (2)", self.text())

    def test_the_verdict_that_sent_the_run_there_is_named(self):
        act = walk(self.g, self.st, {"read_ticket": ["read"], "ready_check": ["gaps"], "verdict": ["exhausted"]})
        self.assertEqual((act.kind, act.step, act.forced), ("ask", "ask_at_limit", None))
        text = self.text()
        self.assertIn("JP-9116 is not Ready yet", text)
        self.assertIn("Why you are asked: `verdict` ended with `exhausted`.", text)
        self.assertNotIn(OLD_CLAIM, text)

    def test_an_ask_that_is_no_limit_gets_no_reason_line(self):
        self.st.done["post_question"] = "posted"          # ask_josh is the drafter's own question, not a limit
        self.assertIsNone(runner.limit_reason(FakeRun(self.g, self.st), "ask_josh"))


if __name__ == "__main__":
    unittest.main()
