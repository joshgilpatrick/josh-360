"""JP-117, Task 3: the runner's foundations: settings, the walker call, the ledger view, session files, locks."""
import json
import os
import signal
import subprocess
import sys
import time
import unittest
from pathlib import Path

from runner_helpers import ROOT, RunnerCase, db, paths
from runner_lib import ledgerview, locks, sessionfile, walk
from ledger import graph_sessions


class Settings(RunnerCase):
    def test_settings_file_overrides_defaults(self):
        self.settings(session_limit=1)
        self.assertEqual(paths.settings()["session_limit"], 1)
        self.assertEqual(paths.settings()["turn_cap"], 200)

    def test_shipped_settings_match_defaults(self):
        os.environ.pop("JOSH360_RUNNER_SETTINGS")
        shipped = json.loads((ROOT / "graphs" / "runner" / "settings.json").read_text())
        self.assertEqual(sorted(shipped), sorted(paths.DEFAULTS))
        self.assertEqual(shipped, paths.DEFAULTS)

    def test_a_settings_file_that_is_not_an_object_is_refused(self):
        self.settings_path.write_text("[1]")
        with self.assertRaises(ValueError):
            paths.settings()

    def test_rails_loaded_needs_all_four_events(self):
        self.assertTrue(paths.rails_loaded())
        self.write_claude_settings(without="Stop")
        self.assertFalse(paths.rails_loaded())
        self.claude_settings.write_text("{")
        self.assertFalse(paths.rails_loaded())


class Parts(RunnerCase):
    def conn(self):
        return db.connect(db.ledger_path())

    def test_walk_returns_the_answer_and_raises_on_refusal(self):
        out = walk.call("start", "--graph", "valid", "--ticket", "JP-901", "--input", "system=sample", root=self.root)
        self.assertIn("run", out)
        with self.assertRaises(walk.WalkerRefused) as caught:
            walk.call("next", "--run", "r-000000000000", root=self.root)
        self.assertIn("there is no run", str(caught.exception))

    def test_open_runs_and_open_step(self):
        run = walk.call("start", "--graph", "valid", "--ticket", "JP-901", "--input", "system=sample",
                        "--runner", "cli", root=self.root)["run"]
        other = walk.call("start", "--graph", "valid", "--ticket", "JP-902", "--input", "system=sample",
                          "--runner", "agent-manager", root=self.root)["run"]
        walk.call("next", "--run", run, root=self.root)
        conn = self.conn()
        try:
            self.assertEqual([r["run"] for r in ledgerview.open_runs(conn, "cli")], [run])
            self.assertEqual([r["run"] for r in ledgerview.open_runs(conn, "agent-manager")], [other])
            step = ledgerview.open_step(conn, run)
            self.assertEqual((step["step"], step["kind"], step["attempt"]), ("design", "role", 1))
            self.assertTrue(ledgerview.ticket_has_open_run(conn, "JP-901"))
            self.assertFalse(ledgerview.ticket_has_open_run(conn, "JP-999"))
        finally:
            conn.close()

    def test_last_ended_run_and_rows(self):
        run = self.start()
        self.walk_happy(run)
        self.assertEqual(self.walker("next", "--run", run)["action"], "done")
        conn = self.conn()
        try:
            self.assertEqual(ledgerview.last_ended_run(conn, "JP-901", "valid"), run)
            self.assertIsNone(ledgerview.last_ended_run(conn, "JP-901", "waits"))
            self.assertFalse(ledgerview.open_runs(conn, "cli"))
            rows = ledgerview.run_rows(conn, run)
            design = [r for r in rows if r["step"] == "design"][0]
            self.assertEqual((design["kind"], design["attempt"], design["outcome"], design["tier"]),
                             ("role", 1, "ready", "mid"))
            self.assertEqual([r["run"] for r in ledgerview.ended_runs(conn, "2000-01-01T00:00:00Z")], [run])
        finally:
            conn.close()

    def test_session_file_round_trip_and_live(self):
        run = self.start()
        sessionfile.write(run, "design", 1, {"state": "spawning", "run": run})
        sessionfile.write(run, "build", 1, {"state": "recorded", "run": run})
        self.assertEqual([d["state"] for d in sessionfile.live([run])], ["spawning"])
        self.assertEqual(sessionfile.read(run, "design", 1)["run"], run)
        self.assertIsNone(sessionfile.read(run, "review", 1))
        sessionfile.path(run, "review", 1).write_text("{")
        with self.assertRaises(sessionfile.Unreadable):
            sessionfile.read(run, "review", 1)
        self.assertEqual(len(sessionfile.live([run])), 2)          # the damaged file counts as live

    def test_lock_is_released_when_its_process_dies(self):
        lock = self.tmp / "x.lock"
        code = ("import sys, time; sys.path.insert(0, {!r}); from runner_lib import locks\n"
                "with locks.held({!r}):\n    print('held', flush=True); time.sleep(60)\n"
                ).format(str(ROOT / "graphs" / "runner"), str(lock))
        child = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE)
        try:
            self.assertEqual(child.stdout.readline().strip(), b"held")
            self.assertTrue(locks.is_held(lock))
            with self.assertRaises(locks.Held):
                with locks.held(lock):
                    pass
        finally:
            child.send_signal(signal.SIGKILL)
            child.wait()
        self.assertFalse(locks.is_held(lock))

    def test_is_graph_session_never_raises(self):
        self.assertFalse(graph_sessions.is_graph_session(None))
        self.assertFalse(graph_sessions.is_graph_session("../x"))
        self.assertFalse(graph_sessions.is_graph_session("no-such-session"))

    def test_runner_sample_passes_the_checker_and_starts(self):
        code, out = self.compile()
        self.assertEqual(code, 0, out)
        run = self.walker("start", "--graph", "runner-sample", "--ticket", "JP-901")["run"]
        self.assertTrue(run.startswith("r-"))


if __name__ == "__main__":
    unittest.main()
