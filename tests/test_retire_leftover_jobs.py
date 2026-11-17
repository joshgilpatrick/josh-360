"""JP-119: the one-time job that switches off three leftover launchd jobs, and the restore script that undoes it.

Everything runs against a made-up HOME and a fake `launchctl`; the real launchd is never touched.
"""
from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from helpers import REPO

RETIRE = REPO / "scripts" / "retire_leftover_jobs.py"
RESTORE = REPO / "scripts" / "restore_retired_job.py"
LABELS = ["com.eventus.qa-waker-watchdog", "com.eventus.clickup-notion-sync", "com.omnara.daemon"]

# A fake launchctl. Each label's state is a file $FAKE_DIR/<label>: "loaded" or "unloaded". Every call is logged.
# `bootout` unloads unless $FAKE_BOOTOUT_FAILS is set; `bootstrap <domain> <plist>` loads the plist's file stem.
FAKE = """#!/bin/sh
echo "$@" >> "$FAKE_LOG"
case "$1" in
  print) f="$FAKE_DIR/${2##*/}"; [ -f "$f" ] && [ "$(cat "$f")" = loaded ] && exit 0 || exit 113 ;;
  bootout) [ -n "$FAKE_BOOTOUT_FAILS" ] && exit 5; echo unloaded > "$FAKE_DIR/${2##*/}"; exit 0 ;;
  bootstrap) b="$(basename "$3" .plist)"; echo loaded > "$FAKE_DIR/$b"; exit 0 ;;
  *) echo "unexpected: $*" >&2; exit 64 ;;
esac
"""


class RetireLeftoverJobsTest(unittest.TestCase):

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="josh360-leftover-"))
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.home = self.tmp / "home"
        self.agents = self.home / "Library" / "LaunchAgents"
        self.agents.mkdir(parents=True)
        self.fake = self.tmp / "launchctl"
        self.fake.write_text(FAKE)
        self.fake.chmod(self.fake.stat().st_mode | stat.S_IXUSR)
        self.fake_dir = self.tmp / "fake-state"
        self.fake_dir.mkdir()
        self.log = self.tmp / "calls.log"
        self.log.write_text("")
        for label in LABELS:
            (self.agents / (label + ".plist")).write_text("<plist>{}</plist>\n".format(label))
        # clickup was never loaded; the other two are loaded
        for label, state in zip(LABELS, ("loaded", "unloaded", "loaded")):
            (self.fake_dir / label).write_text(state)
        self.other = self.agents / "com.example.other.plist"
        self.other.write_text("<plist>other</plist>\n")
        self.omnara = self.home / ".omnara"
        (self.omnara / "Omnara.app").mkdir(parents=True)
        (self.omnara / "Omnara.app" / "binary").write_text("made-up binary\n")

    def env(self, **extra):
        env = dict(os.environ, HOME=str(self.home), JOSH360_LAUNCHCTL=str(self.fake), JOSH360_TODAY="2026-11-17",
                   FAKE_DIR=str(self.fake_dir), FAKE_LOG=str(self.log), PYTHONDONTWRITEBYTECODE="1")
        env.update(extra)
        return env

    def retire(self, *args, **extra):
        return subprocess.run([sys.executable, str(RETIRE)] + list(args), env=self.env(**extra), stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, universal_newlines=True)

    def restore(self, folder, *args, **extra):
        return subprocess.run([sys.executable, str(RESTORE), str(folder)] + list(args), env=self.env(**extra),
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)

    def archive(self, name):
        return self.home / "Archive" / "josh-360-retired" / "2026-11-17" / name

    def state(self, label):
        return (self.fake_dir / label).read_text().strip()

    # -- Switching off ---------------------------------------------------------------------------------------------

    def test_it_switches_off_and_archives_all_three(self):
        r = self.retire()
        self.assertEqual(r.returncode, 0, r.stderr)
        report = json.loads(r.stdout)
        self.assertEqual(report["result"], "ok")
        self.assertEqual([i["label"] for i in report["items"]], LABELS)
        self.assertEqual([self.state(l) for l in LABELS], ["unloaded"] * 3)
        for label, name in zip(LABELS, ("qa-waker-watchdog", "clickup-notion-sync", "omnara")):
            self.assertFalse((self.agents / (label + ".plist")).exists())
            self.assertEqual((self.archive(name) / (label + ".plist")).read_text(), "<plist>{}</plist>\n".format(label))
            self.assertTrue((self.archive(name) / "README.md").is_file())
            self.assertEqual(json.loads((self.archive(name) / "retired.json").read_text())["label"], label)

    def test_omnara_s_folder_moves_by_rename_and_nothing_is_deleted(self):
        self.retire()
        self.assertFalse(self.omnara.exists())
        self.assertEqual((self.archive("omnara") / "data-.omnara" / "Omnara.app" / "binary").read_text(), "made-up binary\n")

    def test_it_touches_only_its_three_labels(self):
        self.retire()
        calls = self.log.read_text()
        self.assertNotIn("com.example.other", calls)
        self.assertEqual(self.other.read_text(), "<plist>other</plist>\n")
        self.assertTrue(all(l.startswith(("print ", "bootout ")) for l in calls.splitlines()), calls)

    def test_a_job_that_was_never_loaded_is_not_booted_out(self):
        self.retire()
        self.assertNotIn("bootout gui/{}/com.eventus.clickup-notion-sync".format(os.getuid()), self.log.read_text())

    def test_a_second_run_does_nothing(self):
        self.retire()
        self.log.write_text("")
        r = self.retire()
        self.assertEqual(r.returncode, 0)
        self.assertEqual(sorted(p.name for p in self.archive("omnara").parent.iterdir()),
                         ["clickup-notion-sync", "omnara", "qa-waker-watchdog"])  # no omnara-2
        self.assertNotIn("bootout", self.log.read_text())

    def test_a_dry_run_changes_nothing(self):
        r = self.retire("--dry-run")
        self.assertEqual(r.returncode, 0)
        self.assertTrue(json.loads(r.stdout)["dry_run"])
        self.assertTrue(all((self.agents / (l + ".plist")).is_file() for l in LABELS))
        self.assertTrue(self.omnara.is_dir())
        self.assertFalse((self.home / "Archive").exists())
        self.assertEqual(self.state("com.omnara.daemon"), "loaded")
        self.assertNotIn("bootout", self.log.read_text())

    def test_when_a_job_will_not_stop_nothing_of_it_moves_and_the_runner_retries(self):
        r = self.retire(FAKE_BOOTOUT_FAILS="1")
        self.assertEqual(r.returncode, 1)
        self.assertTrue((self.agents / "com.omnara.daemon.plist").is_file())
        self.assertTrue(self.omnara.is_dir())  # its app folder is not moved from under a running job
        self.assertEqual(json.loads(r.stdout)["result"], "failed")

    def test_a_plist_that_is_a_link_is_left_alone(self):
        target = self.tmp / "elsewhere.plist"
        target.write_text("<plist>real</plist>\n")
        plist = self.agents / "com.eventus.qa-waker-watchdog.plist"
        plist.unlink()
        plist.symlink_to(target)
        r = self.retire()
        self.assertEqual(r.returncode, 1)
        self.assertTrue(plist.is_symlink())
        self.assertEqual(target.read_text(), "<plist>real</plist>\n")

    def test_without_launchctl_it_changes_nothing(self):
        r = self.retire(JOSH360_LAUNCHCTL=str(self.tmp / "no-such-launchctl"))
        self.assertEqual(r.returncode, 0)
        self.assertEqual(json.loads(r.stdout)["result"], "skipped")
        self.assertTrue(all((self.agents / (l + ".plist")).is_file() for l in LABELS))
        self.assertTrue(self.omnara.is_dir())

    # -- Scenario: Switching off can be undone --------------------------------------------------------------------

    def test_restoring_a_job_that_was_loaded_puts_everything_back_and_loads_it(self):
        original = (self.agents / "com.omnara.daemon.plist").read_bytes()
        self.retire()
        self.assertEqual(self.state("com.omnara.daemon"), "unloaded")
        r = self.restore(self.archive("omnara"))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual((self.agents / "com.omnara.daemon.plist").read_bytes(), original)
        self.assertEqual((self.omnara / "Omnara.app" / "binary").read_text(), "made-up binary\n")
        self.assertEqual(self.state("com.omnara.daemon"), "loaded")  # it runs as before
        self.assertFalse((self.archive("omnara") / "com.omnara.daemon.plist").exists())

    def test_restoring_a_job_that_was_not_loaded_does_not_load_it(self):
        self.retire()
        self.log.write_text("")
        r = self.restore(self.archive("clickup-notion-sync"))
        self.assertEqual(r.returncode, 0)
        self.assertTrue((self.agents / "com.eventus.clickup-notion-sync.plist").is_file())
        self.assertEqual(self.state("com.eventus.clickup-notion-sync"), "unloaded")
        self.assertNotIn("bootstrap", self.log.read_text())

    def test_a_dry_run_restore_changes_nothing(self):
        self.retire()
        r = self.restore(self.archive("omnara"), "--dry-run")
        self.assertEqual(r.returncode, 0)
        self.assertFalse((self.agents / "com.omnara.daemon.plist").exists())
        self.assertFalse(self.omnara.exists())

    def test_restore_refuses_when_something_is_already_in_the_way(self):
        self.retire()
        (self.agents / "com.omnara.daemon.plist").write_text("<plist>new</plist>\n")
        r = self.restore(self.archive("omnara"))
        self.assertEqual(r.returncode, 1)
        self.assertIn("already exists", r.stdout)
        self.assertEqual((self.agents / "com.omnara.daemon.plist").read_text(), "<plist>new</plist>\n")
        self.assertFalse(self.omnara.exists())  # nothing was moved, not even the data folder

    def test_restore_refuses_a_folder_it_did_not_write(self):
        empty = self.tmp / "empty"
        empty.mkdir()
        self.assertEqual(self.restore(empty).returncode, 1)


if __name__ == "__main__":
    unittest.main()
