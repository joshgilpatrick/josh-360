"""The follow job and the status branch (JP-105), end to end against a made-up GitHub and laptop."""
from __future__ import annotations

import json
import unittest

from helpers import LaptopCase

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
        # It holds no file contents: one small file, nothing from the repo.
        self.assertEqual(self.status_tree(), ["status.json"])
        # And the reader a cloud session uses prints it.
        shown = self.laptop("status.py", "show", check=True)
        self.assertIn(merged, shown.stdout)

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


if __name__ == "__main__":
    unittest.main()
