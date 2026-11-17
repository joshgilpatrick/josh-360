"""The walker and a wait step (JP-115): `pending` writes nothing, a declared outcome ends the wait like a gate.

The graph is the checker's `waits` sample: zeta, alpha, hold (a wait on `pr-state`), confirm (an ask), tell.
Run: python3 -m unittest discover -s tests -t tests -p "test_walker_wait.py" -v
"""
import unittest

from walker_helpers import WalkerCase, runfolder


class WalkerWait(WalkerCase):
    def to_hold(self, plan):
        self.plan({"pr-state": plan})
        run = self.start("waits")
        self.do_role(run, "zeta", "ready", {"note": "from zeta"})
        self.do_role(run, "alpha", "done", {"note": "from alpha"})
        return run

    def rows_of(self, run, step):
        return [r for r in self.step_rows(run) if r[0] == step]

    def test_pending_prints_waiting_and_writes_no_row(self):
        run = self.to_hold(["pending", "pending", "merged"])
        first = self.walker("next", "--run", run)
        self.assertEqual((first["action"], first["step"], first["gate"]), ("waiting", "hold", "pr-state"), first)
        self.assertEqual(self.rows_of(run, "hold"), [])
        second = self.walker("next", "--run", run)
        self.assertEqual(second["action"], "waiting")
        self.assertEqual(second["waiting_since"], first["waiting_since"])
        self.assertEqual(self.rows_of(run, "hold"), [])
        third = self.walker("next", "--run", run)
        self.assertEqual((third["action"], third["step"]), ("parked", "confirm"), third)
        rows = self.rows_of(run, "hold")
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0][1], rows[0][2], rows[0][5]), (1, 0, "merged"))

    def test_wait_outputs_are_saved(self):
        run = self.to_hold([{"outcome": "merged", "outputs": {"state": "MERGED"}}])
        self.walker("next", "--run", run)
        self.assertEqual(runfolder.load(run)["outputs"]["hold"]["state"], "MERGED")

    def test_wait_outcome_can_end_the_run(self):
        run = self.to_hold(["closed"])
        out = self.walker("next", "--run", run)
        self.assertEqual((out["action"], out["end"], out["score"]), ("done", "hold.closed", "neutral"), out)

    def test_wait_error_stops_the_run(self):
        run = self.to_hold(["crash"])
        out = self.walker("next", "--run", run)
        self.assertEqual((out["action"], out["step"]), ("stopped", "hold"), out)
        self.assertEqual([r[5] for r in self.rows_of(run, "hold")], ["_error"])

    def test_status_shows_waiting(self):
        run = self.to_hold(["pending", "merged"])
        self.walker("next", "--run", run)
        waiting = self.walker("status", "--run", run)["waiting"]
        self.assertEqual(waiting["step"], "hold")
        self.assertEqual(sorted(waiting), ["checked", "since", "step"])
        self.walker("next", "--run", run)
        self.assertIsNone(self.walker("status", "--run", run)["waiting"])

    def test_a_finished_wait_replays(self):
        run = self.to_hold(["merged"])
        self.walker("next", "--run", run)
        again = self.walker("next", "--run", run)  # would exit 2 with Corrupt if replay refused the wait row
        self.assertEqual((again["action"], again["step"]), ("parked", "confirm"))

    def test_the_summary_is_withheld_on_a_phi_run(self):
        self.plan({"pr-state": [{"outcome": "pending", "summary": "waiting on a person"}]})
        run = self.walker("start", "--graph", "waits", "--ticket", "JP-902", "--input", "system=sample", "--phi")["run"]
        self.do_role(run, "zeta", "ready", {"note": "x"})
        self.do_role(run, "alpha", "done", {"note": "y"})
        self.assertIsNone(self.walker("next", "--run", run)["summary"])


if __name__ == "__main__":
    unittest.main()
