"""JP-196: the console-terminal job against the REAL Agent Manager (the laptop's version), from outside any pane, as
launchd runs it. The job used `terminal list`, which acts as the caller's own pane and so refuses a launchd job; it now
reads `snapshot --json`.

Needs the pinned Agent Manager and tmux 3.1+, like tests/test_e2e_agent_manager.py: without them every test here is
skipped (`python3 tests/e2e/agent_manager.py install`), and with JOSH360_E2E_AM=1 a missing install fails instead.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests" / "e2e"))
import agent_manager  # noqa: E402

AM = agent_manager.installed()
TOOLS = agent_manager.missing_tools()
REQUIRED = os.environ.get("JOSH360_E2E_AM") == "1"
WHY = "the real Agent Manager {} is not here ({}): python3 tests/e2e/agent_manager.py install".format(
    agent_manager.PINNED, "; ".join(TOOLS) or "not installed")
JOB = ROOT / "scripts" / "console_terminal_job.py"


class ConsoleTerminalFromAJob(unittest.TestCase):
    def setUp(self):
        if not AM or TOOLS:
            if REQUIRED:
                self.fail(WHY)
            self.skipTest(WHY)
        self.tmp = Path(tempfile.mkdtemp(prefix="josh360-e2e-console-"))
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.am = agent_manager.Instance(self.tmp / "am", AM).setup()
        self.addCleanup(self.am.stop)
        self.am.start_manager()
        self.josh = self.tmp / "josh"
        (self.josh / "state").mkdir(parents=True)

    def run_job(self):
        """The job as launchd runs it: no pane, no session id, a job's short PATH."""
        env = self.am.env()
        for key in ("AGENT_MANAGER_SESSION_ID", "TMUX", "TMUX_PANE"):
            env.pop(key, None)
        env.update(JOSH360_HOME=str(self.josh), PATH="/usr/bin:/bin:/usr/sbin:/sbin")
        done = subprocess.run([sys.executable, str(JOB)], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, universal_newlines=True, timeout=180, env=env)
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def terminals(self):
        snap = self.am.snapshot() or {}
        return {t["id"]: t for t in snap.get("terminals") or [] if t.get("running") is not False}

    def heartbeat(self, timeout=30.0):
        path = self.josh / "state" / "console-heartbeat.json"
        deadline = time.time() + timeout
        while time.time() < deadline:
            if path.is_file():
                return json.loads(path.read_text(encoding="utf-8"))
            time.sleep(0.5)
        return None

    def test_the_job_opens_the_console_terminal_from_outside_a_pane_and_reuses_it(self):
        report = self.run_job()
        self.assertEqual(report["status"], "started", report)
        tid = report["terminal"]
        self.assertEqual(self.terminals()[tid]["group"], "josh-360")
        self.assertTrue(self.heartbeat(), "the console in the new terminal never wrote its heartbeat")
        self.assertFalse([c for c in self.am.calls("terminal") if c["argv"][:2] == ["terminal", "list"]])

        self.assertEqual(self.run_job()["status"], "running")          # a fresh heartbeat: no Agent Manager call

        (self.josh / "state" / "console-heartbeat.json").unlink()   # stale, and the resend window passed
        record = self.josh / "state" / "console-terminal.json"
        doc = json.loads(record.read_text(encoding="utf-8"))
        doc["sent_at_epoch"] = doc["sent_at_epoch"] - 3600
        record.write_text(json.dumps(doc), encoding="utf-8")
        again = self.run_job()
        self.assertEqual((again["status"], again["terminal"]), ("restarted", tid), again)
        creates = [c for c in self.am.calls("terminal") if c["argv"][:2] == ["terminal", "create"]]
        self.assertEqual(len(creates), 1)                              # never a second console


if __name__ == "__main__":
    unittest.main()
