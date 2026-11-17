"""JP-117: the one-off Agent Manager probe job, run against a fake `agent-manager` and a made-up JOSH360_HOME.

The real Agent Manager is never called. The fake logs every call, answers `--help` and `--version`, refuses
`sessions` the way it does outside a pane, and answers `spawn` with a session id.
"""
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

PROBE = REPO / "scripts" / "agent_manager_probe_job.py"

FAKE = """#!/bin/sh
echo "$@" >> "$FAKE_LOG"
case "$*" in
  *--help*) echo "usage: agent-manager $1"; exit 0 ;;
  --version) echo "agent-manager 0.50.0"; exit 0 ;;
  "sessions --json") echo "agent-manager: not inside an Agent Manager session" >&2; exit 1 ;;
  "terminal list --json") echo '[]'; exit 0 ;;
  spawn*) [ -n "$FAKE_SPAWN_FAILS" ] && { echo "spawn refused" >&2; exit 1; }
          echo '{"id": "s-123", "name": "x"}'; exit 0 ;;
  *) echo "unexpected: $*" >&2; exit 64 ;;
esac
"""


class AgentManagerProbeTest(unittest.TestCase):

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="josh360-amprobe-"))
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.fake = self.tmp / "agent-manager"
        self.fake.write_text(FAKE)
        self.fake.chmod(self.fake.stat().st_mode | stat.S_IXUSR)
        self.log = self.tmp / "calls.log"
        self.log.write_text("")
        self.db = self.tmp / "state.db"
        conn = sqlite3.connect(str(self.db))
        conn.execute("CREATE TABLE sessions (id TEXT, name TEXT, status TEXT, tool TEXT, archived INTEGER, extra TEXT)")
        conn.execute("INSERT INTO sessions VALUES ('s-123', 'secret name', 'idle', 'claude', 0, 'abc')")
        conn.execute("INSERT INTO sessions VALUES ('s-9', 'other', 'working', 'claude', 0, NULL)")
        conn.commit()
        conn.close()

    def run_probe(self, **extra):
        env = dict(os.environ, JOSH360_HOME=str(self.tmp / "home"), JOSH360_AM_BIN=str(self.fake),
                   JOSH360_CLAUDE_BIN="/bin/echo", JOSH360_AM_DB=str(self.db), FAKE_LOG=str(self.log), **extra)
        r = subprocess.run([sys.executable, str(PROBE)], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           universal_newlines=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)

    def calls(self, word):
        return [line for line in self.log.read_text().splitlines() if line.startswith(word)]

    def test_report_holds_shapes_not_values(self):
        report = self.run_probe()
        am = report["agent_manager"]
        self.assertEqual(am["version"], "agent-manager 0.50.0")
        self.assertEqual(am["sessions"]["code"], 1)
        self.assertIn("not inside", am["sessions"]["error"])
        self.assertEqual(report["spawn"]["session_id"], "s-123")
        self.assertEqual(report["database"]["session_statuses"], ["idle", "working"])
        self.assertEqual(report["database"]["probe_session"]["row"]["status"], "idle")
        self.assertIn("extra", report["database"]["probe_session"]["filled_columns"])
        self.assertNotIn("secret name", json.dumps(report))
        self.assertNotIn("abc", json.dumps(report["database"]))

    def test_spawns_once_only(self):
        self.run_probe()
        self.run_probe()
        self.assertEqual(len(self.calls("spawn --name")), 1)

    def test_refused_spawn_is_tried_three_times_in_all(self):
        for _ in range(5):
            report = self.run_probe(FAKE_SPAWN_FAILS="1")
        self.assertEqual(len(self.calls("spawn --name")), 3)
        self.assertEqual(report["spawn"]["error"], "spawn refused")

    def test_detached_child_is_started_once(self):
        first = self.run_probe()
        self.assertIn("started", first["detached"])
        second = self.run_probe()
        self.assertEqual(first["detached"]["started"], second["detached"]["started"])
        self.assertNotIn("survived", second["detached"])  # too soon to say


if __name__ == "__main__":
    unittest.main()
