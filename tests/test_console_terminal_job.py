"""JP-185: the console-terminal job keeps one Agent Manager terminal running the console, with a fake agent-manager."""
import io
import json
import os
import shutil
import stat
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import console_terminal_job as job  # noqa: E402

FAKE = """#!/usr/bin/env python3
import json, os, sys
folder = os.environ["FAKE_AM"]
with open(os.path.join(folder, "calls.jsonl"), "a") as f:
    f.write(json.dumps(sys.argv[1:]) + "\\n")
args = sys.argv[1:]
if args[:2] == ["terminal", "list"]:   # acts as the caller's pane, so a launchd job always gets this (JP-196)
    sys.stderr.write("agent-manager: not inside an Agent Manager session or terminal\\n"); sys.exit(1)
elif args[:1] == ["snapshot"]:
    mode = open(os.path.join(folder, "list")).read() if os.path.exists(os.path.join(folder, "list")) else "[]"
    if mode == "FAIL":
        sys.stderr.write("cannot reach agent manager\\n"); sys.exit(1)
    rows = json.loads(mode)
    print(json.dumps({"version": "0.47.1", "sessions": [], "groups": [],
                      "terminals": rows.get("terminals") if isinstance(rows, dict) else rows}))
elif args[:2] == ["terminal", "create"]:
    print(json.dumps({"id": "term-7", "group": "josh-360"}))
elif args[:1] == ["create-group"]:
    sys.stderr.write("group already exists\\n"); sys.exit(1)
"""
NOW = 1795183800.0  # 2026-11-20T14:10:00Z


class JobCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="josh360-console-job-"))
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.home, self.fake = self.tmp / "home", self.tmp / "am"
        (self.home / "state").mkdir(parents=True)
        self.fake.mkdir()
        binary = self.fake / "agent-manager"
        binary.write_text(FAKE, encoding="utf-8")
        binary.chmod(binary.stat().st_mode | stat.S_IEXEC)
        self._env = {k: os.environ.get(k) for k in ("JOSH360_HOME", "JOSH360_AM_BIN", "FAKE_AM")}
        self.addCleanup(self._restore)
        os.environ.update(JOSH360_HOME=str(self.home), JOSH360_AM_BIN=str(binary), FAKE_AM=str(self.fake))

    def _restore(self):
        for key, value in self._env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def run_job(self, now=NOW):
        out = io.StringIO()
        self.assertEqual(job.main(out=out, now=lambda: now), 0)
        return json.loads(out.getvalue())

    def calls(self):
        path = self.fake / "calls.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def beat(self, at):
        (self.home / "state" / "console-heartbeat.json").write_text(json.dumps(
            {"pid": 1, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(at))}), encoding="utf-8")

    def test_creates_one_terminal_and_sends_the_console(self):
        report = self.run_job()
        self.assertEqual(report["status"], "started")
        self.assertEqual(report["terminal"], "term-7")
        self.assertEqual(report["heartbeat_fresh"], 0)
        create = [c for c in self.calls() if c[:2] == ["terminal", "create"]]
        self.assertEqual(len(create), 1)
        self.assertIn("--group", create[0])
        self.assertEqual(create[0][create[0].index("--group") + 1], "josh-360")
        send = [c for c in self.calls() if c[:2] == ["terminal", "send"]][0]
        self.assertEqual(send[2], "term-7")
        self.assertIn("scripts/console.py", send[4])
        self.assertIn("--heartbeat --name console", send[4])
        record = json.loads((self.home / "state" / "console-terminal.json").read_text())
        self.assertEqual(record["terminal_id"], "term-7")

    def test_fresh_heartbeat_means_no_agent_manager_call(self):
        self.beat(NOW - 40)
        report = self.run_job()
        self.assertEqual(report["status"], "running")
        self.assertEqual(report["heartbeat_fresh"], 1)
        self.assertEqual(self.calls(), [])

    def test_unreadable_list_creates_nothing(self):
        (self.fake / "list").write_text("FAIL")
        report = self.run_job()
        self.assertEqual(report["status"], "unknown")
        self.assertFalse(any(c[:2] == ["terminal", "create"] for c in self.calls()))
        (self.fake / "list").write_text("not json")
        self.assertEqual(self.run_job()["status"], "unknown")
        (self.fake / "list").write_text(json.dumps([{"name": "no id"}]))
        self.assertEqual(self.run_job()["status"], "unknown")
        self.assertFalse(any(c[:2] == ["terminal", "create"] for c in self.calls()))

    def test_off_switch(self):
        (self.home / "state" / "console-off").write_text("")
        self.assertEqual(self.run_job()["status"], "off")
        self.assertEqual(self.calls(), [])

    def test_listed_terminal_with_a_stale_heartbeat_gets_the_command_again(self):
        self.run_job()
        (self.fake / "list").write_text(json.dumps([{"id": "term-7", "name": "console"}]))
        self.beat(NOW - 3600)
        self.assertEqual(self.run_job(now=NOW + 60)["status"], "starting")      # just sent: give it time
        report = self.run_job(now=NOW + 700)
        self.assertEqual(report["status"], "restarted")
        self.assertEqual(len([c for c in self.calls() if c[:2] == ["terminal", "create"]]), 1)
        self.assertEqual(len([c for c in self.calls() if c[:2] == ["terminal", "send"]]), 2)

    def test_adopts_a_terminal_named_console(self):
        (self.fake / "list").write_text(json.dumps({"terminals": [{"id": 42, "title": "console"}]}))
        report = self.run_job()
        self.assertEqual(report["status"], "restarted")
        self.assertEqual(report["terminal"], "42")
        self.assertFalse(any(c[:2] == ["terminal", "create"] for c in self.calls()))

    def test_gone_terminal_is_replaced(self):
        self.run_job()
        (self.fake / "list").write_text(json.dumps([{"id": "other", "name": "shell"}]))
        self.assertEqual(self.run_job(now=NOW + 700)["status"], "started")
        self.assertEqual(len([c for c in self.calls() if c[:2] == ["terminal", "create"]]), 2)

    def test_never_asks_for_the_terminal_list_a_job_cannot_read(self):
        self.assertEqual(self.run_job()["status"], "started")
        self.assertFalse(any(c[:2] == ["terminal", "list"] for c in self.calls()))
        self.assertIn(["snapshot", "--json"], self.calls())

    def test_a_console_terminal_that_stopped_running_is_replaced(self):
        (self.fake / "list").write_text(json.dumps([{"id": "old", "name": "console", "running": False}]))
        self.assertEqual(self.run_job()["status"], "started")
        self.assertEqual(len([c for c in self.calls() if c[:2] == ["terminal", "create"]]), 1)

    def test_no_agent_manager_is_a_report_not_a_crash(self):
        os.environ["JOSH360_AM_BIN"] = str(self.tmp / "missing")
        report = self.run_job()
        self.assertEqual(report["status"], "unknown")


if __name__ == "__main__":
    unittest.main()
