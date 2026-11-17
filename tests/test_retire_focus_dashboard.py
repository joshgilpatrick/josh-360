"""JP-100: the one-time job that switches off the focus dashboard's launchd job and archives its plist.

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

SCRIPT = REPO / "scripts" / "retire_focus_dashboard.py"
LABEL = "com.eventus.focus-dashboard"

# A fake launchctl: state lives in $FAKE_STATE ("loaded" or "unloaded"); every call is logged to $FAKE_LOG.
# `bootout` unloads unless $FAKE_BOOTOUT_FAILS is set.
FAKE = """#!/bin/sh
echo "$@" >> "$FAKE_LOG"
case "$1" in
  print) [ "$(cat "$FAKE_STATE")" = loaded ] && exit 0 || exit 113 ;;
  bootout) [ -n "$FAKE_BOOTOUT_FAILS" ] && exit 5; echo unloaded > "$FAKE_STATE"; exit 0 ;;
  *) echo "unexpected: $*" >&2; exit 64 ;;
esac
"""


class RetireFocusDashboardTest(unittest.TestCase):

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="josh360-focus-"))
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.home = self.tmp / "home"
        (self.home / "Library" / "LaunchAgents").mkdir(parents=True)
        (self.home / ".claude").mkdir()
        self.plist = self.home / "Library" / "LaunchAgents" / (LABEL + ".plist")
        self.plist.write_text("<plist>made-up</plist>\n")
        self.other = self.home / "Library" / "LaunchAgents" / "com.example.other.plist"
        self.other.write_text("<plist>other</plist>\n")
        self.fake = self.tmp / "launchctl"
        self.fake.write_text(FAKE)
        self.fake.chmod(self.fake.stat().st_mode | stat.S_IXUSR)
        self.state = self.tmp / "state"
        self.state.write_text("loaded")
        self.log = self.tmp / "calls.log"
        self.log.write_text("")

    def run_job(self, *args, **extra):
        env = dict(os.environ, HOME=str(self.home), JOSH360_LAUNCHCTL=str(self.fake), JOSH360_TODAY="2026-11-16",
                   FAKE_STATE=str(self.state), FAKE_LOG=str(self.log), PYTHONDONTWRITEBYTECODE="1")
        env.update(extra)
        return subprocess.run([sys.executable, str(SCRIPT)] + list(args), env=env, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, universal_newlines=True)

    def calls(self):
        return self.log.read_text().splitlines()

    def snapshot(self):
        return sorted(str(p.relative_to(self.home)) + ("/" if p.is_dir() else "") for p in self.home.rglob("*"))

    def archive(self):
        return self.home / "Archive" / "josh-360-retired" / "2026-11-16" / "focus-dashboard"

    def test_switches_the_job_off_and_archives_the_plist(self):
        r = self.run_job()
        self.assertEqual(r.returncode, 0, r.stderr)
        report = json.loads(r.stdout)
        self.assertEqual((report["result"], report["was_loaded"]), ("ok", True))
        self.assertEqual(self.state.read_text().strip(), "unloaded")
        self.assertFalse(self.plist.exists())
        self.assertEqual((self.archive() / (LABEL + ".plist")).read_text(), "<plist>made-up</plist>\n")
        readme = (self.archive() / "README.md").read_text()
        self.assertIn("launchctl bootstrap", readme)
        self.assertIn(LABEL + ".plist", readme)
        self.assertTrue(self.other.exists(), "another job's plist was touched")

    def test_only_that_one_label_is_ever_named(self):
        self.run_job()
        for call in self.calls():
            self.assertTrue(call.startswith(("print ", "bootout ")), call)
            self.assertTrue(call.endswith("/" + LABEL), call)

    def test_the_change_can_be_undone_by_hand(self):
        """Putting the plist back and loading it again is the README's whole recipe."""
        self.run_job()
        shutil.move(str(self.archive() / (LABEL + ".plist")), str(self.plist))
        self.assertEqual(self.plist.read_text(), "<plist>made-up</plist>\n")

    def test_dry_run_changes_nothing(self):
        before = self.snapshot()
        r = self.run_job("--dry-run")
        self.assertEqual(r.returncode, 0, r.stderr)
        report = json.loads(r.stdout)
        self.assertTrue(report["dry_run"])
        self.assertIn("would bootout " + LABEL, report["actions"])
        self.assertEqual(self.state.read_text(), "loaded")
        self.assertEqual(before, self.snapshot())
        self.assertFalse(any(c.startswith("bootout") for c in self.calls()))

    def test_running_twice_changes_nothing_the_second_time(self):
        self.run_job()
        before = self.snapshot()
        r = self.run_job()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(before, self.snapshot())
        self.assertEqual(sum(c.startswith("bootout") for c in self.calls()), 1)

    def test_already_gone_is_success(self):
        self.state.write_text("unloaded")
        self.plist.unlink()
        r = self.run_job()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)["result"], "ok")
        self.assertFalse((self.home / "Archive").exists())

    def test_a_failed_bootout_leaves_the_plist_and_asks_to_retry(self):
        r = self.run_job(FAKE_BOOTOUT_FAILS="1")
        self.assertEqual(r.returncode, 1)
        self.assertEqual(json.loads(r.stdout)["result"], "failed")
        self.assertEqual(self.state.read_text(), "loaded")

    def test_never_writes_into_an_earlier_archive(self):
        self.archive().mkdir(parents=True)
        (self.archive() / "keep.txt").write_text("earlier")
        r = self.run_job()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual((self.archive() / "keep.txt").read_text(), "earlier")
        self.assertTrue((self.archive().parent / "focus-dashboard-2" / (LABEL + ".plist")).exists())

    def test_not_a_mac_touches_nothing(self):
        before = self.snapshot()
        r = self.run_job(JOSH360_LAUNCHCTL=str(self.tmp / "no-such-launchctl"))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)["result"], "skipped")
        self.assertEqual(before, self.snapshot())

    def test_reports_focus_hooks_still_in_settings_by_name_only(self):
        (self.home / ".claude" / "settings.json").write_text(json.dumps({"hooks": {"Stop": [{"hooks": [
            {"type": "command", "command": "python3 /x/.claude/hooks/focus-completion-gate.py SECRET-ARG"}]}]}}))
        (self.home / ".claude" / "session-focus").mkdir()
        (self.home / ".claude" / "session-focus" / "a.md").write_text("x")
        r = self.run_job()
        report = json.loads(r.stdout)
        self.assertEqual(report["settings"]["focus_hooks_named"], ["focus-completion-gate.py"])
        self.assertEqual(report["session_focus"], {"folder_exists": True, "files": 1})
        self.assertNotIn("SECRET-ARG", r.stdout)
        self.assertEqual((self.home / ".claude" / "session-focus" / "a.md").read_text(), "x")

    def test_clean_settings_report_no_focus_hooks(self):
        (self.home / ".claude" / "settings.json").write_text("{}")
        report = json.loads(self.run_job().stdout)
        self.assertEqual(report["settings"], {"settings_found": True, "focus_hooks_named": []})


if __name__ == "__main__":
    unittest.main()
