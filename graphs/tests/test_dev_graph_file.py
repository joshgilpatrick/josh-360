"""The development graph file (JP-115): graphs/flows/development.yaml passes the checker and has the doors the
spec names. Run: python3 -m unittest discover -s graphs/tests -p "test_dev_graph_file.py"
"""
from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
GRAPHS = HERE.parent
sys.path.insert(0, str(GRAPHS / "tools"))

import check_graph  # noqa: E402

FILE = GRAPHS / "flows" / "development.yaml"
LIMIT_ASKS = ("design_stuck", "build_stuck", "review_stuck")


class DevelopmentGraphFile(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = check_graph.load_yaml(FILE)
        cls.steps = {s["id"]: s for s in cls.data["steps"]}

    def test_graph_passes_the_checker(self):
        result = subprocess.run([sys.executable, str(GRAPHS / "tools" / "check_graph.py"), str(FILE)],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_asks_josh_lists_every_ask_step(self):
        asks = {sid for sid, s in self.steps.items() if "ask" in s}
        self.assertEqual(set(self.data["header"]["asks_josh"]), asks)

    def test_limit_asks_are_reached_only_at_a_limit(self):
        at_limit, needed, targets = set(), set(), set()
        for s in self.steps.values():
            for then in (s.get("on") or {}).values():
                if isinstance(then, dict):
                    at_limit.add(then["at_limit"])
                    targets.add(then["goto"])
            needed |= set(s.get("needs") or [])
        for sid in LIMIT_ASKS:
            with self.subTest(sid):
                self.assertTrue(self.steps[sid]["ask"].get("on_limit_only"))
                self.assertIn(sid, at_limit)
                self.assertNotIn(sid, needed)
                self.assertNotIn(sid, targets)

    def test_named_asks_have_exactly_these_doors(self):
        doors = {"ask_design": ("route_question", "to_josh"), "approve_design": ("read_ticket", "design_only"),
                 "ask_builder": ("triage_question", "escalate"), "audit_stuck": ("await_review", ["blocked", "stale"]),
                 "ask_fixer": ("fix_review", "needs_input")}
        for sid, (step, outcome) in doors.items():
            with self.subTest(sid):
                self.assertEqual(self.steps[sid]["when"], {"step": step, "outcome": outcome})

    def test_a_build_tickets_question_never_reaches_josh(self):
        self.assertEqual(self.steps["return_question"]["when"], {"step": "route_question", "outcome": "to_triage"})
        self.assertEqual(self.steps["return_question"]["on"], {"returned": "end"})
        self.assertIn("to_triage", self.steps["route_question"]["outcomes"])

    def test_two_waits_and_both_read(self):
        waits = sorted(sid for sid, s in self.steps.items() if "wait" in s)
        self.assertEqual(waits, ["await_merge", "await_review"])
        for sid in waits:
            self.assertEqual(self.data["header"]["access"][sid], "read")


if __name__ == "__main__":
    unittest.main()
