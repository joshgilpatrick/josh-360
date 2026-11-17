"""JP-111: the one-time job that retires the old Session Atlas. A made-up HOME and a fake `launchctl`; nothing real is touched."""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from helpers import REPO

SCRIPT = REPO / "scripts" / "retire_session_atlas.py"
LABEL = "com.eventus.claude-atlas"

FAKE = """#!/bin/sh
echo "$@" >> "$FAKE_LOG"
case "$1" in
  print) [ "$(cat "$FAKE_STATE")" = loaded ] && exit 0 || exit 113 ;;
  bootout) [ -n "$FAKE_BOOTOUT_FAILS" ] && exit 5; echo unloaded > "$FAKE_STATE"; exit 0 ;;
  *) echo "unexpected: $*" >&2; exit 64 ;;
esac
"""

SETTINGS = {
    "model": "x",
    "hooks": {
        "SessionStart": [
            {"hooks": [{"type": "command", "command": "node /dev/claude-360/hooks/atlas-hook.js", "timeout": 5}]},
            {"hooks": [{"type": "command", "command": "~/.josh-360/repo/hooks/dispatch SessionStart"}]},
        ],
        "PreToolUse": [
            {"matcher": "Bash", "hooks": [
                {"type": "command", "command": "node /dev/claude-360/hooks/atlas-removal-guard.js", "timeout": 15},
                {"type": "command", "command": "~/other/guard.sh"}]},
        ],
        "PostToolUse": [
            {"matcher": "Bash", "hooks": [{"type": "command", "command": "bash /dev/claude-360/hooks/jira-link-hook.sh"}]},
        ],
    },
}


def make_db(path, ddl, rows=()):
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(str(path))
    db.executescript(ddl)
    for sql, args in rows:
        db.execute(sql, args)
    db.commit()
    db.close()


class RetireSessionAtlasTest(unittest.TestCase):

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="josh360-atlas-retire-"))
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.home = self.tmp / "home"
        self.agents = self.home / "Library" / "LaunchAgents"
        self.agents.mkdir(parents=True)
        self.plist = self.agents / (LABEL + ".plist")
        self.plist.write_text("<plist>made-up</plist>\n")
        self.other = self.agents / "com.example.other.plist"
        self.other.write_text("<plist>other</plist>\n")
        self.settings = self.home / ".claude" / "settings.json"
        self.settings.parent.mkdir(parents=True)
        self.settings.write_text(json.dumps(SETTINGS, indent=2))
        make_db(self.home / ".claude" / "atlas" / "atlas.db", "CREATE TABLE sessions (session_id TEXT);",
                [("INSERT INTO sessions VALUES (?)", ("sess-0001",))])
        make_db(self.home / ".claude" / "cost-ledger" / "ledger.db",
                "CREATE TABLE pricing_runs (id INTEGER PRIMARY KEY, started_at TEXT);",
                [("INSERT INTO pricing_runs VALUES (1, 'made-up')", ())])
        self.j360 = self.home / ".josh-360"
        self.set_backfill(0)
        self.fake = self.tmp / "launchctl"
        self.fake.write_text(FAKE)
        self.fake.chmod(self.fake.stat().st_mode | stat.S_IXUSR)
        self.state = self.tmp / "state"
        self.state.write_text("loaded")
        self.log = self.tmp / "calls.log"
        self.log.write_text("")

    def set_backfill(self, code):
        (self.j360 / "state").mkdir(parents=True, exist_ok=True)
        (self.j360 / "state" / "jobs-state.json").write_text(json.dumps({"ledger-backfill": {"last_run": 1, "last_result": code}}))

    def run_job(self, *args, **extra):
        env = dict(os.environ, HOME=str(self.home), JOSH360_HOME=str(self.j360), JOSH360_LAUNCHCTL=str(self.fake),
                   JOSH360_TODAY="2026-11-17", FAKE_STATE=str(self.state), FAKE_LOG=str(self.log), PYTHONDONTWRITEBYTECODE="1")
        env.update(extra)
        return subprocess.run([sys.executable, str(SCRIPT)] + list(args), env=env, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, universal_newlines=True)

    def archive(self):
        return self.home / "Archive" / "josh-360-retired" / "2026-11-17" / "session-atlas"

    def snapshot(self):
        return sorted(str(p.relative_to(self.home)) for p in self.home.rglob("*"))

    def test_switches_off_archives_and_seeds(self):
        r = self.run_job()
        self.assertEqual(r.returncode, 0, r.stderr)
        report = json.loads(r.stdout)
        self.assertEqual((report["result"], report["cache_db"]), ("ok", "seeded"))
        self.assertEqual(self.state.read_text().strip(), "unloaded")
        a = self.archive()
        self.assertEqual((a / (LABEL + ".plist")).read_text(), "<plist>made-up</plist>\n")
        self.assertTrue((a / "atlas-atlas.db").is_file())
        self.assertTrue((a / "cost-ledger-ledger.db").is_file())
        self.assertIn("launchctl bootstrap", (a / "README.md").read_text())
        self.assertFalse((self.home / ".claude" / "atlas" / "atlas.db").exists())
        self.assertFalse((self.home / ".claude" / "cost-ledger" / "ledger.db").exists())
        self.assertFalse(self.plist.exists())
        self.assertTrue(self.other.exists(), "another job's plist was touched")
        # the old cost ledger's rows are in the new cache.db, and the archived copy still holds them too
        seeded = sqlite3.connect(str(self.j360 / "state" / "cache.db"))
        self.assertEqual(seeded.execute("SELECT COUNT(*) FROM pricing_runs").fetchone()[0], 1)
        seeded.close()
        old = sqlite3.connect(str(a / "atlas-atlas.db"))
        self.assertEqual(old.execute("SELECT COUNT(*) FROM sessions").fetchone()[0], 1)
        old.close()

    def test_only_the_old_atlas_hooks_leave_settings_and_a_backup_is_kept(self):
        original = self.settings.read_text()
        r = self.run_job()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)["hooks_removed"],
                         {"atlas-hook.js": 1, "atlas-removal-guard.js": 1, "jira-link-hook.sh": 1})
        data = json.loads(self.settings.read_text())
        self.assertEqual(data["model"], "x")
        self.assertEqual(data["hooks"]["SessionStart"], [SETTINGS["hooks"]["SessionStart"][1]])
        self.assertEqual(data["hooks"]["PreToolUse"][0]["hooks"], [{"type": "command", "command": "~/other/guard.sh"}])
        self.assertNotIn("PostToolUse", data["hooks"])
        bak = self.archive() / "settings.json.bak"
        self.assertEqual(bak.read_text(), original)
        self.assertEqual(stat.S_IMODE(bak.stat().st_mode), 0o600)

    def test_it_waits_for_the_backfill_and_changes_nothing(self):
        self.set_backfill(1)
        before = self.snapshot()
        r = self.run_job()
        self.assertEqual(r.returncode, 1)
        self.assertEqual(json.loads(r.stdout)["result"], "waiting")
        self.assertEqual(self.state.read_text(), "loaded")
        self.assertEqual(before, self.snapshot())

    def test_a_failed_bootout_touches_no_file(self):
        before = self.snapshot()
        settings_before = self.settings.read_text()
        r = self.run_job(FAKE_BOOTOUT_FAILS="1")
        self.assertEqual(r.returncode, 1)
        self.assertEqual(json.loads(r.stdout)["result"], "failed")
        self.assertEqual(before, self.snapshot())
        self.assertEqual(self.settings.read_text(), settings_before)

    def test_a_cache_db_holding_data_is_never_overwritten(self):
        make_db(self.j360 / "state" / "cache.db", "CREATE TABLE messages (x TEXT);",
                [("INSERT INTO messages VALUES ('kept')", ())])
        r = self.run_job()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)["cache_db"], "kept-existing")
        db = sqlite3.connect(str(self.j360 / "state" / "cache.db"))
        self.assertEqual(db.execute("SELECT x FROM messages").fetchall(), [("kept",)])
        db.close()

    def test_an_unreadable_cache_db_is_kept(self):
        (self.j360 / "state" / "cache.db").write_text("this is not a database")
        r = self.run_job()
        self.assertEqual(json.loads(r.stdout)["cache_db"], "kept-existing")
        self.assertEqual((self.j360 / "state" / "cache.db").read_text(), "this is not a database")

    def test_an_empty_cache_db_made_by_the_jira_hook_is_archived_and_seeded(self):
        # the hook can open (and so create) cache.db before this job has run; keeping it would strand the old history
        make_db(self.j360 / "state" / "cache.db",
                "CREATE TABLE pricing_runs (id INTEGER PRIMARY KEY, started_at TEXT); "
                "CREATE TABLE messages (x TEXT); CREATE TABLE schema_migrations (id INTEGER);",
                [("INSERT INTO schema_migrations VALUES (1)", ())])
        r = self.run_job()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)["cache_db"], "replaced-empty-and-seeded")
        db = sqlite3.connect(str(self.j360 / "state" / "cache.db"))
        self.assertEqual(db.execute("SELECT COUNT(*) FROM pricing_runs").fetchone()[0], 1)
        db.close()
        self.assertTrue((self.archive() / "state-cache.db").is_file(), "the empty file was not archived")

    def test_dry_run_reports_the_replacement_and_changes_nothing(self):
        make_db(self.j360 / "state" / "cache.db", "CREATE TABLE messages (x TEXT);")
        before = self.snapshot()
        r = self.run_job("--dry-run")
        self.assertEqual(json.loads(r.stdout)["cache_db"], "would-replace-empty-and-seed")
        self.assertEqual(before, self.snapshot())

    def test_the_wal_files_move_with_their_database(self):
        for suffix in ("-wal", "-shm"):
            (self.home / ".claude" / "atlas" / ("atlas.db" + suffix)).write_text("x")
        r = self.run_job()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue((self.archive() / "atlas-atlas.db-wal").is_file())
        self.assertTrue((self.archive() / "atlas-atlas.db-shm").is_file())
        self.assertFalse((self.home / ".claude" / "atlas" / "atlas.db-wal").exists())

    def test_dry_run_changes_nothing(self):
        before = self.snapshot()
        settings_before = self.settings.read_text()
        r = self.run_job("--dry-run")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(json.loads(r.stdout)["dry_run"])
        self.assertEqual(before, self.snapshot())
        self.assertEqual(self.settings.read_text(), settings_before)
        self.assertEqual(self.state.read_text(), "loaded")

    def test_running_twice_changes_nothing_the_second_time(self):
        self.run_job()
        before = self.snapshot()
        r = self.run_job()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(before, self.snapshot())
        self.assertEqual(sum(c.startswith("bootout") for c in self.log.read_text().splitlines()), 1)

    def test_already_gone_is_success(self):
        for p in (self.plist, self.home / ".claude" / "atlas" / "atlas.db", self.home / ".claude" / "cost-ledger" / "ledger.db"):
            p.unlink()
        self.settings.write_text("{}")
        self.state.write_text("unloaded")
        self.set_backfill(1)  # nothing to read any more, so nothing to wait for
        r = self.run_job()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)["result"], "ok")
        self.assertFalse((self.home / "Archive").exists())

    def test_a_settings_file_that_is_not_json_is_left_alone(self):
        self.settings.write_text("{ not json atlas-hook.js")
        r = self.run_job()
        self.assertEqual(r.returncode, 1)
        self.assertEqual(self.settings.read_text(), "{ not json atlas-hook.js")
        self.assertTrue((self.home / ".claude" / "atlas" / "atlas.db").exists(), "files moved although hooks could not be removed")

    def test_only_that_one_label_is_ever_named(self):
        self.run_job()
        for call in self.log.read_text().splitlines():
            self.assertTrue(call.startswith(("print ", "bootout ")), call)
            self.assertTrue(call.endswith("/" + LABEL), call)

    def test_not_a_mac_touches_nothing(self):
        before = self.snapshot()
        r = self.run_job(JOSH360_LAUNCHCTL=str(self.tmp / "no-such-launchctl"))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)["result"], "skipped")
        self.assertEqual(before, self.snapshot())


if __name__ == "__main__":
    unittest.main()
