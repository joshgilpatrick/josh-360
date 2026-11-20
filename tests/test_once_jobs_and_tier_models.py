"""JP-183: a laptop `every: once` job whose failure won't fix itself stops retrying hourly, and doctor checks that every
tier model is one Agent Manager accepts. Made-up jobs, a made-up clock and the doctor's made-up laptop; nothing real runs."""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import doctor_helpers as h  # noqa: I001  (first: it puts scripts/ on the path)

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "laptop"))
import common  # noqa: E402
import failure_kinds as kinds  # noqa: E402
import run_jobs  # noqa: E402

HOUR = 3600.0
START = 1_800_000_000.0

NO_CREDENTIAL = """import sys
sys.path.insert(0, {laptop!r})
import failure_kinds
failure_kinds.needs_fix("no Jira token in the keychain item jira-claude-api-key")
"""
FLAKY = "import sys\nsys.stderr.write('connection reset by peer\\n')\nsys.exit(1)\n"
BAD_IMPORT = "import no_such_module_anywhere\n"


class OnceJobs(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="jp183-jobs-"))
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        patcher = mock.patch.dict(os.environ, {"JOSH360_HOME": str(self.tmp / "home")})
        patcher.start()
        self.addCleanup(patcher.stop)
        for sub in ("state", "logs"):
            (self.tmp / "home" / sub).mkdir(parents=True)
        self.repo = self.tmp / "repo"
        (self.repo / "jobs").mkdir(parents=True)
        self.jobs = []
        self.clock = [START]
        for target, value in ((run_jobs, "REPO_ROOT"),):
            p = mock.patch.object(target, value, self.repo)
            p.start()
            self.addCleanup(p.stop)
        p = mock.patch.object(run_jobs, "load_jobs", side_effect=lambda root: list(self.jobs))
        p.start()
        self.addCleanup(p.stop)
        p = mock.patch.object(run_jobs.time, "time", side_effect=lambda: self.clock[0])
        p.start()
        self.addCleanup(p.stop)

    def job(self, jid, body):
        (self.repo / "jobs" / (jid + ".py")).write_text(body)
        self.jobs.append({"id": jid, "run": "jobs/{}.py".format(jid), "every": None, "timeout": 60.0, "report": False})

    def passes(self, n, gap=HOUR + 1):
        """n passes of the job runner, `gap` seconds apart; returns how many times each job ran."""
        ran = {}
        real = run_jobs.run_job

        def counting(job, lane):
            ran[job["id"]] = ran.get(job["id"], 0) + 1
            return real(job, lane)
        with mock.patch.object(run_jobs, "run_job", side_effect=counting), mock.patch("builtins.print"):
            for _ in range(n):
                run_jobs.one_pass(common.Lane())
                self.clock[0] += gap
        return ran

    def state(self):
        return json.loads((common.state_dir() / "jobs-state.json").read_text())

    def test_a_once_job_that_can_never_succeed_stops_retrying(self):
        """@auto Given an every-once laptop job that fails because a credential is missing, When run_jobs runs on later
        passes, Then it does not rerun the job until its inputs change or it is resumed, and doctor names it as needing
        a fix."""
        self.job("needs-token", NO_CREDENTIAL.format(laptop=str(REPO / "laptop")))
        self.assertEqual(self.passes(4), {"needs-token": 1})
        rec = self.state()["needs-token"]
        self.assertEqual((rec["last_result"], rec["reason"], rec["kind"]), (78, "job-needs-fix", "needs-fix"))
        self.assertEqual(rec["said"], "no Jira token in the keychain item jira-claude-api-key")
        # its inputs change: the script is edited (a merge would move the commit the same way)
        script = self.repo / "jobs" / "needs-token.py"
        script.write_text(script.read_text() + "# changed\n")
        self.assertEqual(self.passes(3), {"needs-token": 1})
        # or Josh resumes it
        with mock.patch("builtins.print"):
            self.assertEqual(run_jobs.resume("needs-token", common.Lane()), 0)
        self.assertEqual(self.passes(2), {"needs-token": 1})

    def test_an_import_error_waits_for_a_code_change(self):
        self.job("broken", BAD_IMPORT)
        self.assertEqual(self.passes(3), {"broken": 1})
        self.assertEqual(self.state()["broken"]["reason"], "job-code")

    def test_a_failure_that_may_clear_is_still_retried_hourly(self):
        self.job("flaky", FLAKY)
        self.assertEqual(self.passes(3), {"flaky": 3})
        self.assertEqual((self.state()["flaky"]["kind"], self.state()["flaky"]["said"]),
                         ("may-clear", "connection reset by peer"))
        self.assertEqual(self.passes(2, gap=60), {"flaky": 1})            # not more often than hourly, as before

    def test_resume_refuses_a_job_that_is_not_waiting_for_a_fix(self):
        self.job("flaky", FLAKY)
        self.passes(1)
        with mock.patch("builtins.print"):
            self.assertEqual(run_jobs.resume("flaky", common.Lane()), 1)

    def test_the_exit_code_sorting(self):
        self.assertEqual(kinds.job_reason(78, ""), "job-needs-fix")
        self.assertEqual(kinds.job_reason(124, "timed out"), "job-timed-out")
        self.assertEqual(kinds.job_reason(1, "Traceback...\nModuleNotFoundError: No module named 'x'"), "job-code")
        self.assertEqual(kinds.job_reason(1, "something else"), "job-failed")


class DoctorNamesIt(h.DoctorCase):
    def test_doctor_names_a_once_job_that_needs_a_fix(self):
        path = self.home / "state" / "jobs-state.json"
        state = json.loads(path.read_text())
        state["ledger-friction-catchup"] = {"last_run": h.NOW.timestamp() - 600, "last_result": 78,
                                            "reason": "job-needs-fix", "kind": "needs-fix",
                                            "said": "no transcripts folder at ~/.claude/projects", "inputs": "abc"}
        path.write_text(json.dumps(state))
        r = self.results()["backfills.ledger-friction-catchup"]
        self.assertEqual(r.status, "fail")
        self.assertIn("needs a fix (job-needs-fix): no transcripts folder", r.detail)
        self.assertIn("run_jobs.py --resume ledger-friction-catchup", r.fix)

    def test_the_shipped_tiers_are_ones_agent_manager_accepts(self):
        self.assertEqual(self.results()["graphs.tier-models"].status, "pass")

    def test_doctor_catches_a_bad_tier_model_before_any_run(self):
        """@auto Given graphs/tiers.yaml names a model Agent Manager does not list, When doctor runs, Then it fails the
        check and names the tier and the model."""
        compiled = self.copy / "graphs" / "compiled" / "development.json"
        doc = json.loads(compiled.read_text())
        doc["tiers"]["mid"] = [{"model": "claude-made-up-9", "effort": "medium"}]
        compiled.write_text(json.dumps(doc))
        r = self.results()["graphs.tier-models"]
        self.assertEqual(r.status, "fail")
        self.assertIn("tier mid names model claude-made-up-9", r.detail)
        self.assertIn("graphs/tiers.yaml", r.fix)

    def test_doctor_catches_a_bad_effort(self):
        compiled = self.copy / "graphs" / "compiled" / "development.json"
        doc = json.loads(compiled.read_text())
        doc["tiers"]["gate"] = [{"model": "claude-opus-5-5", "effort": "enormous"}]
        compiled.write_text(json.dumps(doc))
        self.assertIn("tier gate names effort enormous", self.results()["graphs.tier-models"].detail)


if __name__ == "__main__":
    unittest.main()
