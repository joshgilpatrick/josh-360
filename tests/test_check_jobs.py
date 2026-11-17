"""JP-119: the startup-list check (laptop/check_jobs.py).

Everything runs against a made-up HOME, a made-up macbook-automations checkout and a fake `launchctl`; the real
launchd is never touched.
"""
from __future__ import annotations

import json
import os
import plistlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from helpers import REPO

SCRIPT = REPO / "laptop" / "check_jobs.py"
sys.path.insert(0, str(REPO / "laptop"))
import check_jobs  # noqa: E402
import common  # noqa: E402

# A fake launchctl: `list` prints $FAKE_LIST, or fails when $FAKE_LIST_FAILS is set.
FAKE = """#!/bin/sh
case "$1" in
  list) [ -n "$FAKE_LIST_FAILS" ] && exit 113; cat "$FAKE_LIST"; exit 0 ;;
  *) echo "unexpected: $*" >&2; exit 64 ;;
esac
"""

LIST_HEADER = "PID\tStatus\tLabel\n"


def plist_bytes(label: str) -> bytes:
    return plistlib.dumps({"Label": label, "ProgramArguments": ["/bin/true"]})


class CheckJobsTest(unittest.TestCase):

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="josh360-check-"))
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.home = self.tmp / "home"
        self.agents = self.home / "Library" / "LaunchAgents"
        self.agents.mkdir(parents=True)
        self.startup = self.tmp / "macbook_automations"
        (self.startup / "launchd").mkdir(parents=True)
        self.fake = self.tmp / "launchctl"
        self.fake.write_text(FAKE)
        self.fake.chmod(self.fake.stat().st_mode | stat.S_IXUSR)
        self.listing = self.tmp / "list.txt"
        self.loaded = []
        # The startup list as it stands on 17 November: the runner entry plus one ordinary job.
        self.on_list("com.jgilpatrick.josh-360-jobs")
        self.on_list("com.jgilpatrick.automations-hub")
        self.install("com.jgilpatrick.startup")
        self.load("com.jgilpatrick.startup")

    def on_list(self, label, load=True):
        name = "launchd/{}.plist".format(label)
        (self.startup / name).write_bytes(plist_bytes(label))
        with (self.startup / "launchd" / "startup-manifest.txt").open("a") as f:
            f.write(name + "\n")
        if load:
            self.load(label)

    def install(self, label):
        (self.agents / (label + ".plist")).write_bytes(plist_bytes(label))

    def load(self, label):
        self.loaded.append(label)

    def run_check(self, *args, **extra):
        self.listing.write_text(LIST_HEADER + "".join("-\t0\t{}\n".format(l) for l in self.loaded))
        env = dict(os.environ, HOME=str(self.home), JOSH360_LAUNCHCTL=str(self.fake), FAKE_LIST=str(self.listing),
                   JOSH360_STARTUP_REPO=str(self.startup), JOSH360_HOME=str(self.tmp / "j360"),
                   PYTHONDONTWRITEBYTECODE="1")
        env.update(extra)
        return subprocess.run([sys.executable, str(SCRIPT), "--json"] + list(args), env=env, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, universal_newlines=True)

    def report(self, **extra):
        r = self.run_check(**extra)
        return r.returncode, json.loads(r.stdout), r

    # -- Scenario: Every Josh 360 job is on the list --------------------------------------------------------------

    def test_every_running_josh_360_job_is_on_the_list(self):
        code, rep, _ = self.report()
        self.assertEqual(rep["differences"], [])
        self.assertEqual(rep["unknown"], [])
        self.assertTrue(rep["ok"])
        self.assertEqual(code, 0)
        self.assertEqual(rep["on_list"], ["com.jgilpatrick.automations-hub", "com.jgilpatrick.josh-360-jobs"])

    def test_known_jobs_managed_elsewhere_and_vendor_jobs_are_not_reported(self):
        for label in ("com.eventus.action-agent", "com.jgilpatrick.sprint-waker-sprints", "homebrew.mxcl.postgresql@14"):
            self.install(label)
            self.load(label)
        for label in ("us.zoom.updater.gui.501", "com.apple.Finder", "application.com.apple.Safari.1.2",
                      "com.microsoft.teams2.agent"):
            self.load(label)
        self.install("us.zoom.updater.gui.501")
        code, rep, _ = self.report()
        self.assertEqual(rep["differences"], [], rep)
        self.assertEqual(code, 0)

    # -- Scenario: A stray job is reported ------------------------------------------------------------------------

    def test_a_stray_job_is_printed(self):
        self.install("com.example.stray")
        self.load("com.example.stray")
        code, rep, r = self.report()
        self.assertEqual(code, 1)
        self.assertEqual([(d["kind"], d["label"]) for d in rep["differences"]], [("stray", "com.example.stray")])
        text = subprocess.run([sys.executable, str(SCRIPT)], stdout=subprocess.PIPE, universal_newlines=True,
                              env=dict(os.environ, HOME=str(self.home), JOSH360_LAUNCHCTL=str(self.fake),
                                       FAKE_LIST=str(self.listing), JOSH360_STARTUP_REPO=str(self.startup),
                                       JOSH360_HOME=str(self.tmp / "j360"))).stdout
        self.assertIn("stray: com.example.stray", text)

    def test_a_loaded_job_with_no_plist_under_josh_s_names_is_a_stray_but_a_vendor_job_is_not(self):
        self.load("com.eventus.mystery")
        self.load("com.somebody.else")
        code, rep, _ = self.report()
        self.assertEqual([d["label"] for d in rep["differences"]], ["com.eventus.mystery"])

    def test_a_josh_360_job_that_is_not_on_the_list_is_reported(self):
        self.install("com.josh360.new-thing")
        self.load("com.josh360.new-thing")
        code, rep, _ = self.report()
        self.assertEqual(code, 1)
        self.assertEqual([(d["kind"], d["label"]) for d in rep["differences"]],
                         [("Josh 360 job not on the list", "com.josh360.new-thing")])

    def test_the_session_atlas_service_is_a_known_gap_not_a_failure(self):
        self.install("com.josh360.session-atlas")
        self.load("com.josh360.session-atlas")
        code, rep, _ = self.report()
        self.assertEqual(code, 0)
        self.assertEqual(rep["differences"], [])
        self.assertEqual([g["label"] for g in rep["known_gaps"]], ["com.josh360.session-atlas"])
        self.assertIn("phase 1 close", rep["known_gaps"][0]["detail"])

    def test_once_the_atlas_service_is_on_the_list_it_is_no_gap(self):
        self.on_list("com.josh360.session-atlas")
        self.install("com.josh360.session-atlas")
        code, rep, _ = self.report()
        self.assertEqual((code, rep["known_gaps"], rep["differences"]), (0, [], []))

    # -- Scenario: Switching off ----------------------------------------------------------------------------------

    def test_a_retired_job_that_is_still_loaded_or_installed_is_reported(self):
        self.load("com.omnara.daemon")
        self.install("com.eventus.qa-waker-watchdog")
        code, rep, _ = self.report()
        self.assertEqual(code, 1)
        self.assertEqual([(d["kind"], d["label"]) for d in rep["differences"]],
                         [("retired but present", "com.eventus.qa-waker-watchdog"),
                          ("retired but present", "com.omnara.daemon")])
        self.assertIn("retire-leftover-jobs", rep["differences"][0]["detail"])

    # -- Unknown is not empty -------------------------------------------------------------------------------------

    def test_an_unreadable_launchctl_is_unknown_not_clean(self):
        code, rep, _ = self.report(FAKE_LIST_FAILS="1")
        self.assertEqual(code, 2)
        self.assertFalse(rep["ok"])
        self.assertIn("launchctl list could not be read", rep["unknown"])
        self.assertEqual(rep["differences"], [])  # it did not guess that every list job is missing

    def test_a_missing_startup_list_is_unknown_and_no_stray_is_guessed(self):
        self.install("com.example.stray")
        self.load("com.example.stray")
        code, rep, _ = self.report(JOSH360_STARTUP_REPO=str(self.tmp / "nowhere"))
        self.assertEqual(code, 2)
        self.assertIn("the startup list could not be read", rep["unknown"])
        self.assertEqual(rep["differences"], [])
        self.assertFalse(rep["startup_repo_found"])

    def test_a_job_on_the_list_that_is_not_loaded_or_has_no_plist_is_reported(self):
        self.on_list("com.jgilpatrick.never-loaded", load=False)
        with (self.startup / "launchd" / "startup-manifest.txt").open("a") as f:
            f.write("launchd/com.jgilpatrick.missing.plist\n# launchd/com.jgilpatrick.commented-out.plist\n")
        code, rep, _ = self.report()
        self.assertEqual(code, 1)
        self.assertEqual(sorted((d["kind"], d["label"]) for d in rep["differences"]),
                         [("on the list but not loaded", "com.jgilpatrick.never-loaded"),
                          ("plist missing", "launchd/com.jgilpatrick.missing.plist")])

    def test_it_changes_nothing(self):
        before = sorted(p.name for p in self.home.rglob("*"))
        self.report()
        self.assertEqual(sorted(p.name for p in self.home.rglob("*")), before)


class ListParsingTest(unittest.TestCase):

    def test_parse_launchctl_list(self):
        text = "PID\tStatus\tLabel\n-\t0\tcom.a\n123\t-15\tcom.b\nnot a row\n"
        self.assertEqual(check_jobs.parse_launchctl_list(text),
                         {"com.a": {"running": False, "last_exit": "0"}, "com.b": {"running": True, "last_exit": "-15"}})


class RegisterTest(unittest.TestCase):

    def data(self):
        return json.loads((REPO / "laptop" / "launchd-register.json").read_text())

    def test_the_register_loads_and_every_row_has_a_reason(self):
        reg = check_jobs.load_register()
        self.assertTrue(reg.elsewhere and reg.retired and reg.transitional)
        self.assertTrue(all(r["reason"] for r in reg.elsewhere + reg.ignore + reg.transitional))

    def test_a_typo_in_the_register_stops_the_check(self):
        for mutate in (lambda d: d.update(elsewhre=[]), lambda d: d["elsewhere"][0].pop("reason"),
                       lambda d: d["elsewhere"][0].update(decision="maybe"), lambda d: d["retired"].append({"label": "x"})):
            data = self.data()
            mutate(data)
            with self.assertRaises(common.Unexpected):
                check_jobs.Register(data)

    def test_a_label_is_in_one_category_only(self):
        reg = check_jobs.load_register()
        seen = {}
        for name, rows in (("elsewhere", reg.elsewhere), ("transitional", reg.transitional), ("retired", reg.retired)):
            for row in rows:
                self.assertNotIn(row["label"], seen, "{} is in {} and {}".format(row["label"], seen.get(row["label"]), name))
                seen[row["label"]] = name

    def test_every_job_in_the_laptop_inventory_is_accounted_for(self):
        """Each job label in docs/inventory/laptop.md is on the startup list (by its row), or in the register."""
        reg = check_jobs.load_register()
        text = (REPO / "docs" / "inventory" / "laptop.md").read_text(encoding="utf-8")
        section = text.split("## Background jobs", 1)[1].split("\n## ", 1)[0]
        rows = [l for l in section.splitlines() if l.startswith("| `")]
        self.assertGreater(len(rows), 25)
        for line in rows:
            cells = [c.strip() for c in line.strip("|").split("|")]
            label = re.sub(r"<[a-z]+>", "x", cells[0].strip("`"))
            known = (reg.elsewhere_row(label) or reg.retired_row(label) or reg.transitional_row(label)
                     or label in (reg.entry_point, "com.jgilpatrick.josh-360-jobs")
                     or "startup list" in cells[2] or "not on the laptop" in cells[4])
            self.assertTrue(known, "{} is neither on the startup list nor in laptop/launchd-register.json".format(label))


if __name__ == "__main__":
    unittest.main()
