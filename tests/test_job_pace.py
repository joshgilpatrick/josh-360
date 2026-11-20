"""JP-181: the job runner keeps its five-minute pace when ledger-record is slow.

The real jobs.yaml, the real runner loop (laptop/run_jobs.py one_pass), and a made-up clock: each job "takes" a set
time, capped at its own timeout as subprocess.run would cap it. No job is really started.
"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "laptop"))
import common  # noqa: E402
import run_jobs  # noqa: E402

PASS_STARTS = 1_800_000_000.0
FIVE_MINUTES = 300.0


class Pace(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="jp181-pace-"))
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        patcher = mock.patch.dict(os.environ, {"JOSH360_HOME": str(self.tmp / "home")})
        patcher.start()
        self.addCleanup(patcher.stop)
        (self.tmp / "home" / "state").mkdir(parents=True)
        (self.tmp / "home" / "logs").mkdir(parents=True)

    def one_pass(self, takes):
        """Run one pass with every job due except the one-time jobs, which already succeeded (the laptop's normal
        state). `takes` maps a job id to the seconds it would run; every other job takes five seconds. Returns
        {job id: seconds after the pass started that it began}."""
        jobs = common.load_jobs(REPO)
        state = {j["id"]: {"last_run": PASS_STARTS - 86400 * 30, "last_result": 0} for j in jobs if j["every"] is None}
        common.Lane().write_text(common.state_dir() / "jobs-state.json", common.dump_json(state))
        clock = [PASS_STARTS]
        began = {}

        def fake_run(job, lane):
            began[job["id"]] = clock[0] - PASS_STARTS
            clock[0] += min(float(takes.get(job["id"], 5.0)), float(job["timeout"]))
            return 124 if takes.get(job["id"], 5.0) > float(job["timeout"]) else 0

        with mock.patch.object(run_jobs, "run_job", side_effect=fake_run), \
                mock.patch.object(run_jobs.time, "time", side_effect=lambda: clock[0]), \
                mock.patch("builtins.print"):
            run_jobs.one_pass(common.Lane())
        return began

    def test_a_slow_ledger_record_does_not_delay_the_graph_runner(self):
        """JP-181 @auto: Given ledger-record takes longer than five minutes, When the job runner makes a pass,
        Then graph-runner still runs in that pass within five minutes of the pass starting."""
        began = self.one_pass({"ledger-record": 11 * 60})
        self.assertIn("ledger-record", began)
        self.assertIn("graph-runner", began, "graph-runner did not run in the pass")
        self.assertLessEqual(began["graph-runner"], FIVE_MINUTES,
                             "graph-runner began {:.0f}s into the pass".format(began["graph-runner"]))

    def test_the_daily_jobs_do_not_delay_the_graph_runner_either(self):
        """The same pass on a day when every daily job is due and each runs to its own timeout."""
        jobs = common.load_jobs(REPO)
        slow = {str(j["id"]): float(j["timeout"]) for j in jobs
                if j["every"] is not None and float(j["every"]) >= 3600}  # type: ignore[arg-type]
        slow["ledger-record"] = 11 * 60
        began = self.one_pass(slow)
        self.assertLessEqual(began["graph-runner"], FIVE_MINUTES)

    def test_ledger_record_still_runs_before_the_graph_runner(self):
        """The graph runner reads what the recorder wrote (its exit gate waits for the recorder), so in one pass the
        recorder still goes first, and its timeout leaves the graph runner room inside five minutes."""
        ids = [str(j["id"]) for j in common.load_jobs(REPO)]
        self.assertLess(ids.index("ledger-record"), ids.index("graph-runner"))
        record = next(j for j in common.load_jobs(REPO) if j["id"] == "ledger-record")
        self.assertLessEqual(float(record["timeout"]), 4 * 60)  # type: ignore[arg-type]


if __name__ == "__main__":
    unittest.main()
