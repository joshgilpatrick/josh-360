"""The follow job and the status branch (JP-105), end to end against a made-up GitHub and laptop."""
from __future__ import annotations

import json
import os
import unittest

import shutil
import sys
import tempfile
from pathlib import Path
from unittest import mock

from helpers import PY, REPO, LaptopCase, run

sys.path.insert(0, str(REPO / "laptop"))
import common  # noqa: E402
import run_jobs  # noqa: E402

STATUS_KEYS = {"schema", "commit", "main", "time", "result", "reason", "counts"}


class FollowTest(LaptopCase):

    def test_a_merge_reaches_the_laptop_on_its_own(self):
        """Scenario: A merge reaches the laptop on its own (one launchd pass of the runner, nothing else)."""
        merged = self.merge("docs/new-note.md", "# A note merged to main\n")
        self.assertNotEqual(self.laptop_head(), merged)
        result = self.laptop("run_jobs.py")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.laptop_head(), merged)
        self.assertTrue((self.laptop_repo / "docs" / "new-note.md").is_file())
        installed = json.loads((self.j360 / "state" / "installed.json").read_text())
        self.assertEqual(installed["commit"], merged)

    def test_a_cloud_session_can_see_the_result(self):
        """Scenario: A cloud session can see the result."""
        merged = self.merge("docs/new-note.md", "# A note\n")
        self.laptop("run_jobs.py", check=True)
        status = self.status_on_branch()
        self.assertEqual(set(status), STATUS_KEYS)
        self.assertEqual(status["commit"], merged)
        self.assertEqual(status["result"], "passed")
        self.assertRegex(status["time"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        self.assertEqual(set(status["counts"]), {"changed", "unchanged", "problems"})
        # It holds no file contents: one small status file, nothing from the repo, plus the reports of
        # report jobs (JP-96's one-time inventory: names, paths, sizes and counts only; JP-100's one-time
        # focus dashboard retirement, which reports "not loaded" here because launchctl is a stub; JP-111's old Atlas
        # retirement and its launchd service job, which only ever talk to that stub; JP-107's one-time ledger backfill
        # and JP-112's one-time friction catch-up, whose reports are counts only, and which find nothing in the
        # made-up home; JP-119's one-time retirement of three leftover jobs, which talks only to the stub, and its
        # daily startup-list check, whose report is job labels and counts; JP-152's daily doctor, whose report is
        # check results with names, counts and paths only; JP-117's graph runner, which finds no credentials and no
        # runs in the made-up home, so its report is counts and ids; and JP-117's temporary triage job for JP-116, which
        # finds no tick report and says it is waiting).
        tree = self.status_tree()
        self.assertEqual([p for p in tree if not p.startswith("reports/")], ["status.json"])
        self.assertEqual([p for p in tree if p.startswith("reports/")],
                         ["reports/console-terminal.json", "reports/doctor.json", "reports/graph-runner.json",
                          "reports/inventory.json", "reports/jp-117-triage-jp-116.json", "reports/launchd-check.json",
                          "reports/ledger-backfill.json",
                          "reports/ledger-friction-catchup.json", "reports/ledger-upload.json",
                          "reports/retire-focus-dashboard.json", "reports/retire-leftover-jobs.json",
                          "reports/retire-session-atlas.json", "reports/session-atlas-service.json",
                          "reports/ticket-comments.json"])
        # And the reader a cloud session uses prints it.
        shown = self.laptop("status.py", "show", check=True)
        self.assertIn(merged, shown.stdout)

    def test_jobs_never_reach_the_real_launchd(self):
        """A run of the job runner, on a Mac or not, only ever talks to the stub launchctl, and never boots anything out."""
        self.laptop("run_jobs.py", check=True)
        calls = self.launchctl_log.read_text().splitlines() if self.launchctl_log.exists() else []
        self.assertTrue(calls, "the retire job should have asked the stub launchctl whether the job is loaded")
        self.assertTrue(all(c.startswith(("list", "print ", "bootstrap ", "kickstart ")) for c in calls), calls)
        # Only the new Atlas service is ever loaded, and only into the made-up home.
        self.assertEqual([c for c in calls if c.startswith("bootstrap ")],
                         ["bootstrap gui/{} {}".format(os.getuid(), self.home / "Library" / "LaunchAgents"
                                                       / "com.josh360.session-atlas.plist")])

    def test_nothing_new_is_not_pushed_again(self):
        self.laptop("follow.py", check=True)
        self.assertEqual(self.status_commits(), 1)
        again = self.laptop("follow.py", check=True)
        self.assertIn("status: skipped", again.stdout)
        self.assertEqual(self.status_commits(), 1)

    def test_josh_can_pause_it_on_the_laptop(self):
        """Scenario: Josh can pause it (local switch)."""
        before = self.laptop_head()
        self.laptop("pause.py", "on", check=True)
        self.merge("docs/new-note.md", "# A note\n")
        result = self.laptop("follow.py")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(self.laptop_head(), before)
        self.assertEqual(self.status_on_branch()["result"], "paused")
        self.laptop("pause.py", "off", check=True)
        self.laptop("follow.py", check=True)
        self.assertNotEqual(self.laptop_head(), before)

    def test_josh_can_pause_it_from_the_cloud(self):
        """Scenario: Josh can pause it (a laptop-pause branch on GitHub)."""
        before = self.laptop_head()
        self.git_work("push", "--quiet", "origin", "main:laptop-pause")
        self.merge("docs/new-note.md", "# A note\n")
        self.laptop("follow.py", check=True)
        self.assertEqual(self.laptop_head(), before)
        status = self.status_on_branch()
        self.assertEqual(status["result"], "paused")
        self.assertIn("laptop-pause", status["reason"])

    def test_a_failed_install_leaves_the_last_good_install(self):
        before = self.laptop_head()
        self.merge("jobs.yaml", "jobs:\n  - id: not-follow\n    run: laptop/follow.py\n    every: 1h\n")
        result = self.laptop("follow.py")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.laptop_head(), before)
        status = self.status_on_branch()
        self.assertEqual(status["result"], "failed")
        self.assertEqual(status["commit"], before)

    def test_local_changes_stop_it(self):
        (self.laptop_repo / "README.md").write_text("edited by hand on the laptop\n")
        before = self.laptop_head()
        self.merge("docs/new-note.md", "# A note\n")
        self.assertEqual(self.laptop("follow.py").returncode, 1)
        self.assertEqual(self.laptop_head(), before)
        self.assertIn("local changes", self.status_on_branch()["reason"])

    def test_a_once_job_reports_back_on_the_status_branch(self):
        """The mechanism the inventory (JP-96) will use: a once job whose JSON output comes back."""
        self.merge("laptop/sample_report.py", "import json\nprint(json.dumps({'items': 3}))\n")
        self.merge("jobs.yaml", (self.work / "jobs.yaml").read_text()
                   + "  - id: sample-report\n    run: laptop/sample_report.py\n    every: once\n    report: true\n")
        first = self.laptop("run_jobs.py")
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        self.assertIn("reports/sample-report.json", self.status_tree())
        report = json.loads(self.origin_git("show", "laptop-status:reports/sample-report.json").stdout)
        self.assertEqual(report, {"items": 3})
        self.assertEqual(self.status_on_branch()["result"], "passed")
        second = self.laptop("run_jobs.py", check=True)
        self.assertNotIn("sample-report", second.stdout)

    def test_refuses_to_run_from_any_other_clone(self):
        """A clone Josh works in is never moved, recorded as installed, or reported."""
        other = self.tmp / "josh-dev-clone"
        run(["git", "-c", "core.hooksPath=/dev/null", "clone", "--quiet", "--branch", "main", str(self.origin),
             str(other)], self.tmp, self.env)
        run(["git", "-c", "core.hooksPath=/dev/null", "checkout", "--quiet", "-b", "my-work"], other, self.env)
        self.merge("docs/new-note.md", "# A note\n")
        head = run(["git", "rev-parse", "HEAD"], other, self.env).stdout
        for script in ("follow.py", "run_jobs.py", "install.py"):
            result = run([PY, str(other / "laptop" / script)], other, self.env, check=False)
            self.assertNotEqual(result.returncode, 0, script)
            self.assertIn("runs only from the laptop's copy", result.stdout, script)
        self.assertEqual(run(["git", "rev-parse", "HEAD"], other, self.env).stdout, head)
        self.assertEqual(run(["git", "branch", "--show-current"], other, self.env).stdout.strip(), "my-work")
        self.assertFalse((self.j360 / "state" / "installed.json").exists())
        self.assertEqual(self.status_commits(), 0)
        # A preview still works from anywhere.
        self.assertEqual(run([PY, str(other / "laptop" / "install.py"), "--dry-run"], other, self.env,
                             check=False).returncode, 0)


class LocalReportCopyTest(unittest.TestCase):
    """JP-166: a report job keeps its newest output under state/reports/<id>.json, for the validation collectors.

    run_job is called in this process, against a made-up home and made-up job scripts; nothing is published.
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="josh360-copy-"))
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.home = self.tmp / "home"
        patch = mock.patch.dict(os.environ, {"JOSH360_HOME": str(self.home)})
        patch.start()
        self.addCleanup(patch.stop)
        self.lane = common.Lane()
        self.lane.mkdir(common.state_dir())
        self.lane.mkdir(common.logs_dir())
        self.script = self.tmp / "report_job.py"
        self.flag = self.tmp / "fail-now"

    def job(self, body):
        self.script.write_text("import json, os, sys\n" + body)
        return {"id": "sample-job", "run": str(self.script), "every": 60, "timeout": 30, "report": True}

    def copy_path(self):
        return common.state_dir() / "reports" / "sample-job.json"

    def test_report_job_keeps_a_local_copy(self):
        job = self.job("print(json.dumps({'items': 3}))\n")
        with mock.patch.object(run_jobs.status_branch, "publish", return_value="pushed"):
            self.assertEqual(run_jobs.run_job(job, self.lane), 0)
        self.assertEqual(json.loads(self.copy_path().read_text()), {"items": 3})

    def test_local_copy_survives_a_failed_publish(self):
        job = self.job("print(json.dumps({'items': 4}))\n")
        with mock.patch.object(run_jobs.status_branch, "publish", side_effect=common.Unexpected("no network")):
            self.assertEqual(run_jobs.run_job(job, self.lane), 1)
        self.assertEqual(json.loads(self.copy_path().read_text()), {"items": 4})

    def test_failed_job_leaves_the_earlier_copy(self):
        job = self.job("if os.path.exists(%r):\n    sys.exit(3)\nprint(json.dumps({'items': 5}))\n" % str(self.flag))
        with mock.patch.object(run_jobs.status_branch, "publish", return_value="pushed"):
            self.assertEqual(run_jobs.run_job(job, self.lane), 0)
            self.flag.write_text("x")
            self.assertEqual(run_jobs.run_job(job, self.lane), 3)
        self.assertEqual(json.loads(self.copy_path().read_text()), {"items": 5})

    def test_output_that_is_not_json_leaves_no_copy(self):
        job = self.job("print('not json')\n")
        with mock.patch.object(run_jobs.status_branch, "publish", return_value="pushed"):
            self.assertEqual(run_jobs.run_job(job, self.lane), 1)
        self.assertFalse(self.copy_path().exists())

    def test_a_copy_that_cannot_be_written_does_not_stop_the_pass(self):
        """A full disk, or reports/ being a file, must not abort the runner or cost the job its publish."""
        job = self.job("print(json.dumps({'items': 6}))\n")
        (common.state_dir() / "reports").write_text("in the way")
        with mock.patch.object(run_jobs.status_branch, "publish", return_value="pushed") as publish:
            self.assertEqual(run_jobs.run_job(job, self.lane), 0)
        publish.assert_called_once()

    def test_a_job_that_is_not_a_report_keeps_no_copy(self):
        job = dict(self.job("print(json.dumps({'items': 3}))\n"), report=False)
        self.assertEqual(run_jobs.run_job(job, self.lane), 0)
        self.assertFalse(self.copy_path().exists())


if __name__ == "__main__":
    unittest.main()
