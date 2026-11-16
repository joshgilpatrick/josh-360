"""The install script (JP-105): stays in its lane, safe to run twice, stops on the unexpected."""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

from helpers import REPO, LaptopCase

sys.path.insert(0, str(REPO / "laptop"))
import common  # noqa: E402


class InstallTest(LaptopCase):

    def test_stays_in_its_lane(self):
        """Scenario: The install script stays in its lane."""
        outside_before = self.snapshot(self.home, skip=self.j360)
        result = self.laptop("install.py", check=True)
        self.assertIn("install: passed", result.stdout)
        self.assertEqual(outside_before, self.snapshot(self.home, skip=self.j360))
        # Everything it made is under ~/.josh-360, apart from the copy of the repo itself.
        made = {p for p in self.snapshot(self.j360, skip=self.laptop_repo)}
        self.assertEqual(made, {"state/", "logs/", "state/installed.json"})

    def test_running_twice_reports_no_changes(self):
        """Scenario: Running it twice is safe."""
        first = self.laptop("install.py", "--json", check=True)
        self.assertGreater(json.loads(first.stdout.splitlines()[-1])["changed"], 0)
        before = self.snapshot(self.home)
        second = self.laptop("install.py", "--json", check=True)
        summary = json.loads(second.stdout.splitlines()[-1])
        self.assertEqual(summary, {"result": "passed", "changed": 0, "unchanged": 4, "problems": 0})
        self.assertNotIn("changed  ", second.stdout)
        self.assertEqual(before, self.snapshot(self.home))

    def test_dry_run_changes_nothing(self):
        before = self.snapshot(self.home)
        result = self.laptop("install.py", "--dry-run", check=True)
        self.assertIn("would", result.stdout)
        self.assertEqual(before, self.snapshot(self.home))

    def test_stops_with_nothing_changed_on_the_unexpected(self):
        (self.j360 / "logs").write_text("a file where a folder should be\n")
        before = self.snapshot(self.home)
        result = self.laptop("install.py")
        self.assertEqual(result.returncode, 3)
        self.assertIn("stopped: nothing was changed", result.stdout)
        self.assertEqual(before, self.snapshot(self.home))

    def test_stops_on_a_linked_state_folder(self):
        elsewhere = self.tmp / "elsewhere"
        elsewhere.mkdir()
        self.j360.joinpath("state").symlink_to(elsewhere)
        result = self.laptop("install.py")
        self.assertEqual(result.returncode, 3)
        self.assertIn("is a link", result.stdout)
        self.assertEqual(list(elsewhere.iterdir()), [])

    def test_stops_on_a_bad_hooks_folder(self):
        (self.laptop_repo / "hooks" / "NotAnEvent").mkdir()
        before = self.snapshot(self.home)
        result = self.laptop("install.py")
        self.assertEqual(result.returncode, 3)
        self.assertIn("NotAnEvent is not a known hook event folder", result.stdout)
        self.assertEqual(before, self.snapshot(self.home))


class LaneTest(unittest.TestCase):

    def test_refuses_any_path_outside_home(self):
        lane = common.Lane(Path("/tmp/josh360-lane-test"))
        for bad in ("/tmp/elsewhere", "/tmp/josh360-lane-test-evil/x", "/tmp/josh360-lane-test/../x"):
            with self.assertRaises(common.Unexpected):
                lane.check(Path(bad))
        self.assertEqual(lane.check(Path("/tmp/josh360-lane-test/state/a")), Path("/tmp/josh360-lane-test/state/a"))


class JobsFileTest(unittest.TestCase):

    def parse(self, text):
        return common.validate_jobs(common.parse_jobs_text(text), REPO)

    def test_the_real_file_starts_with_follow(self):
        jobs = common.load_jobs(REPO)
        self.assertEqual(jobs[0]["id"], "follow")
        self.assertEqual(jobs[0]["run"], "laptop/follow.py")

    def test_once_and_report(self):
        jobs = self.parse("jobs:\n  - id: follow\n    run: laptop/follow.py\n    every: 10m\n"
                          "  - id: inventory\n    run: laptop/status.py\n    every: once\n    report: true\n")
        self.assertIsNone(jobs[1]["every"])
        self.assertTrue(jobs[1]["report"])

    def test_rejects_what_it_does_not_expect(self):
        good = "jobs:\n  - id: follow\n    run: laptop/follow.py\n    every: 10m\n"
        bad = {
            "tab": good.replace("    every", "\tevery"),
            "unknown key": good + "    colour: red\n",
            "first not follow": good.replace("id: follow", "id: other"),
            "bad every": good.replace("10m", "often"),
            "outside repo": good.replace("laptop/follow.py", "../evil.py"),
            "missing file": good.replace("laptop/follow.py", "laptop/nope.py"),
            "duplicate id": good + "  - id: follow\n    run: laptop/follow.py\n    every: 1h\n",
            "flow syntax": good.replace("10m", "[10m]"),
            "no header": good.replace("jobs:\n", ""),
        }
        for name, text in bad.items():
            with self.subTest(name), self.assertRaises(common.Unexpected):
                self.parse(text)


if __name__ == "__main__":
    unittest.main()
