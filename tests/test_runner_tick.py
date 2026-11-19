"""JP-117, Task 10: the tick, the job and the terminal loop. The graphs are the fixture graphs (`runner-sample`, `valid`),
the Jira is the made-up folder one and Agent Manager is the fake; nothing here starts a real session."""
import io
import json
import os
import signal
import subprocess
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

from runner_helpers import ROOT, RunnerCase, db, runfolder
from runner_lib import locks, notify, paths, status, tick, watch

import runner as runner_cli
import tick_job

AM = ("--runner", "agent-manager")
SLEEPY_GATE = """#!/usr/bin/env python3
import os, sys, time
open(os.environ["WALKER_TEST_PID_FILE"], "w").write(str(os.getppid()))
time.sleep(20)
print('{"outcome": "pass"}')
"""


class Ticking(RunnerCase):
    def setUp(self):
        super().setUp()
        rule = dict(json.loads((ROOT / "graphs" / "runner" / "starts.json").read_text())["graphs"]["development"],
                    route="runner-sample")
        self.starts = self.tmp / "starts.json"
        self.starts.write_text(json.dumps({"per_pass": 1, "graphs": {"runner-sample": rule}}))
        os.environ.update({"JOSH360_RUNNER_STARTS": str(self.starts), "JOSH360_GRAPHS_ROOT": str(self.root),
                           "PYTHONDONTWRITEBYTECODE": "1"})
        self.launched = []

    def tick(self, launcher=None, **kw):
        return tick.tick(now=lambda: self.now, launcher=launcher or self.launched.append, root=self.root, **kw)

    def runs(self):
        conn = db.connect(db.ledger_path())
        try:
            return [r[0] for r in conn.execute("SELECT run_id FROM graph_runs ORDER BY id")]
        finally:
            conn.close()

    def parked(self, ticket="JP-902"):
        run = self.start("valid", ticket, *AM)
        self.do_role(run, "design", "ready", {"spec_path": "spec-1"})
        self.assertEqual(self.walker("next", "--run", run)["step"], "approve_spec")
        return run

    def stopped(self, ticket="JP-903"):
        self.plan({"lint-spec": ["crash"]})
        run = self.start("valid", ticket, *AM)
        self.do_role(run, "design", "ready", {"spec_path": "spec-1"})
        self.assertEqual(self.walker("next", "--run", run)["action"], "stopped")
        return run

    def test_tick_starts_a_run_and_launches_its_advance(self):
        self.jira_issue("JP-901")
        report = self.tick()
        self.assertEqual(report["watch"]["runner-sample"]["started"], ["JP-901"])
        self.assertEqual(self.launched, self.runs())
        self.assertEqual(len(self.launched), 1)

    def test_ready_without_the_run_label_launches_nothing(self):
        self.jira_issue("JP-901", queued=False)
        report = self.tick()
        self.assertEqual(report["watch"]["runner-sample"]["started"], [])
        self.assertEqual((self.launched, self.runs()), ([], []))

    def test_failed_search_leaves_open_runs_alone(self):
        run = self.start("runner-sample", "JP-950", *AM)
        before = self.step_rows(run)
        self.jira_issue("JP-901")
        self.jira_state(search_fails=True)
        report = self.tick()
        self.assertEqual(report["watch"]["runner-sample"]["jira"], "unknown")
        self.assertEqual(self.step_rows(run), before)
        self.assertEqual(self.launched, [run])

    def test_parked_run_is_not_launched_until_it_is_answered(self):
        run = self.parked()
        self.tick()
        self.assertEqual(self.launched, [])
        self.answer_in_app(run, "approve_spec", "build")
        self.tick()
        self.assertEqual(self.launched, [run])

    def test_stopped_run_is_launched_once(self):
        run = self.stopped()
        advancing = lambda r: (self.launched.append(r), self.advance(r))                 # noqa: E731
        self.tick(launcher=advancing)
        self.tick(launcher=advancing)
        self.assertEqual(self.launched, [run])
        self.walker("retry", "--run", run)
        self.plan({})
        self.tick(launcher=advancing)
        self.assertEqual(self.launched, [run, run])

    def test_a_second_stop_at_the_same_step_is_notified_again(self):
        run = self.stopped()
        with mock.patch.object(notify, "notify") as told:
            self.tick(launcher=self.advance)
            self.tick(launcher=self.advance)
            self.walker("retry", "--run", run)                     # still crashes: the plan is unchanged
            self.tick(launcher=self.advance)
            self.tick(launcher=self.advance)
        stops = [c for c in told.call_args_list if "stopped" in c.args[1]]
        self.assertEqual(len(stops), 2)

    def test_locked_run_is_not_launched(self):
        run = self.start("valid", "JP-901", *AM)
        with locks.held(runfolder.folder(run) / "advance.lock"):
            self.tick()
        self.assertEqual(self.launched, [])

    def test_off_switch_skips_the_watch(self):
        paths.off_file().parent.mkdir(parents=True, exist_ok=True)
        paths.off_file().write_text("")
        self.jira_issue("JP-901")
        report = self.tick()
        self.assertEqual(report["watch"], {})
        self.assertEqual((self.jira_calls(), self.runs(), report["status"]), ([], [], "off"))

    def test_two_ticks_at_once(self):
        with locks.held(paths.state_dir() / "tick.lock"):
            self.assertEqual(self.tick(), {"status": "busy"})

    def test_report_does_not_change_between_idle_passes(self):
        self.start("valid", "JP-901", *AM)
        first = self.tick()
        self.assertEqual(self.tick(), first)
        self.assertEqual(json.loads((paths.state_dir() / "report.json").read_text()), first)
        self.assertNotIn("generated", json.dumps(first))

    def test_detached_child_does_not_hold_the_pass(self):
        pid_file = self.tmp / "gate.pid"
        os.environ["WALKER_TEST_PID_FILE"] = str(pid_file)
        run = self.start("valid", "JP-902", *AM)
        self.do_role(run, "design", "ready", {"spec_path": "spec-1"})
        (self.root / "gates" / "lint-spec.py").write_text(SLEEPY_GATE)
        self.assertEqual(self.compile()[0], 0)

        def stop_child():
            try:
                os.kill(int(pid_file.read_text()), signal.SIGTERM)
            except (OSError, ValueError):
                pass
        self.addCleanup(stop_child)
        began = time.time()
        done = subprocess.run([sys.executable, str(ROOT / "graphs" / "runner" / "runner.py"), "tick"],
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=60)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertLess(time.time() - began, 10)
        json.loads(done.stdout)
        for _ in range(50):
            if paths.run_log(run).exists():
                break
            time.sleep(0.1)
        self.assertTrue(paths.run_log(run).exists())

    # -- needs_advance ----------------------------------------------------------------------------------------
    def test_needs_advance_reads_only_files_and_the_ledger(self):
        run = self.start("valid", "JP-901", *AM)
        conn = db.connect(db.ledger_path())
        try:
            row = {"run": run}
            with mock.patch("runner_lib.walk.call") as walked:
                self.assertTrue(tick.needs_advance(conn, row))
            walked.assert_not_called()
            (runfolder.folder(run) / "run.json").write_text("{")
            self.assertFalse(tick.needs_advance(conn, row))
        finally:
            conn.close()


class Hosting(RunnerCase):
    def setUp(self):
        super().setUp()
        os.environ.update({"JOSH360_GRAPHS_ROOT": str(self.root), "PYTHONDONTWRITEBYTECODE": "1"})
        (self.tmp / "starts.json").write_text(json.dumps({"per_pass": 1, "graphs": {}}))
        os.environ["JOSH360_RUNNER_STARTS"] = str(self.tmp / "starts.json")

    def job(self):
        out = io.StringIO()
        self.assertEqual(tick_job.main(out=out, now=lambda: self.now), 0)
        return json.loads(out.getvalue())

    def beat(self, seconds_ago):
        paths.state_dir().mkdir(parents=True, exist_ok=True)
        (paths.state_dir() / "heartbeat.json").write_text(json.dumps({"at": self.now - seconds_ago, "pid": 1}))

    def test_job_host_runs_a_tick(self):
        report = self.job()
        self.assertEqual((report["status"], report["host"]), ("ok", "job"))
        self.assertNotIn("loop", report)

    def test_terminal_host_job_reports_a_stale_loop(self):
        self.settings(host="terminal")
        with mock.patch.object(notify, "notify") as told:
            report = self.job()
            self.assertTrue(report["loop"]["stale"])
            self.assertEqual(told.call_count, 1)
            self.assertEqual(told.call_args.args, ("Josh 360 runner",
                                                   "The graph runner loop has stopped. Start it again in an Agent Manager terminal."))
            self.job()
            self.assertEqual(told.call_count, 1)                   # not again while it stays stale
            self.beat(30)
            self.assertFalse(self.job()["loop"]["stale"])
            self.beat(601)
            self.assertTrue(self.job()["loop"]["stale"])
            self.assertEqual(told.call_count, 2)                   # fresh in between, so a new notification
        self.assertEqual(self.am_calls("spawn"), [])

    def test_loop_refuses_under_the_job_host(self):
        with self.assertRaises(tick.LoopRefused):
            tick.loop(sleep=lambda s: None, turns=1)
        self.assertEqual(runner_cli.main(["loop"], io.StringIO()), 2)

    def test_loop_refuses_when_another_loop_holds_the_lock(self):
        self.settings(host="terminal")
        with locks.held(paths.state_dir() / "loop.lock"):
            with self.assertRaises(tick.LoopRefused):
                tick.loop(sleep=lambda s: None, turns=1)

    def test_loop_ticks_and_beats(self):
        self.settings(host="terminal")
        slept = []
        with mock.patch.object(tick, "tick", wraps=tick.tick) as ticked:
            tick.loop(sleep=slept.append, turns=2)
        self.assertEqual((ticked.call_count, slept), (2, [300, 300]))
        beat = json.loads((paths.state_dir() / "heartbeat.json").read_text())
        self.assertEqual(beat["pid"], os.getpid())

    def test_loop_goes_on_after_a_failed_turn(self):
        self.settings(host="terminal")
        with mock.patch.object(tick, "tick", side_effect=[RuntimeError("boom"), {"status": "ok"}]) as ticked:
            tick.loop(sleep=lambda s: None, turns=2)
        self.assertEqual(ticked.call_count, 2)


class Commanding(RunnerCase):
    def setUp(self):
        super().setUp()
        os.environ.update({"JOSH360_GRAPHS_ROOT": str(self.root), "PYTHONDONTWRITEBYTECODE": "1"})

    def cli(self, *argv, code=0):
        out = io.StringIO()
        self.assertEqual(runner_cli.main(list(argv), out), code, out.getvalue())
        return out.getvalue()

    def test_start_command(self):
        got = json.loads(self.cli("start", "--graph", "valid", "--ticket", "JP-901", "--input", "system=sample"))
        conn = db.connect(db.ledger_path())
        try:
            row = conn.execute("SELECT runner, ticket_key FROM graph_runs WHERE run_id = ?", (got["run"],)).fetchone()
        finally:
            conn.close()
        self.assertEqual(tuple(row), ("agent-manager", "JP-901"))
        self.assertEqual(self.am_calls("spawn"), [])               # start works and starts no session

    def test_start_works_when_the_runner_is_off(self):
        paths.off_file().parent.mkdir(parents=True, exist_ok=True)
        paths.off_file().write_text("")
        self.assertIn("run", json.loads(self.cli("start", "--graph", "valid", "--ticket", "JP-901", "--input", "system=sample")))

    def test_a_walker_refusal_is_exit_2_with_an_error(self):
        got = json.loads(self.cli("start", "--graph", "no-such-graph", "--ticket", "JP-901", code=2))
        self.assertIn("error", got)

    def test_advance_command(self):
        run = json.loads(self.cli("start", "--graph", "valid", "--ticket", "JP-901", "--input", "system=sample"))["run"]
        self.assertEqual(json.loads(self.cli("advance", "--run", run)), {"run": run, "state": "spawned"})

    def test_status_command_in_words_and_json(self):
        run = json.loads(self.cli("start", "--graph", "valid", "--ticket", "JP-901", "--input", "system=sample"))["run"]
        self.assertIn("JP-901 valid", self.cli("status"))
        self.assertEqual(json.loads(self.cli("status", "--json"))["runs"]["open"], 1)
        self.assertEqual(run, json.loads(self.cli("status", "--json"))["open_runs"][0]["run"])

    def test_report_from_the_published_json(self):
        run = self.end_sample_run()
        direct = self.cli("report", "--run", run)
        conn = db.connect(db.ledger_path())
        try:
            snapshot = status.snapshot(conn, time.time(), self.root)
        finally:
            conn.close()
        published = self.tmp / "report.json"
        published.write_text(json.dumps(snapshot))
        # from a published snapshot the report is the same table, with no cost (a dash and a note; JP-170)
        from_json = self.cli("report", "--run", run, "--from-json", str(published))
        self.assertIn("Cost is not in a published snapshot", from_json)
        self.assertEqual(len(from_json.splitlines()) - 2, len(direct.splitlines()))
        live = json.loads(self.cli("report", "--run", run, "--json"))
        for step in live["steps"]:
            self.assertEqual(sorted(k for k in step if k.startswith("cost")), ["cost_pricing", "cost_usd"])
            step.pop("cost_usd"), step.pop("cost_pricing")
        live["with_cost"] = False
        self.assertEqual(json.loads(self.cli("report", "--run", run, "--from-json", str(published), "--json")), live)
        self.assertEqual(json.loads(self.cli("report", "--run", run, "--json"))["run"], run)
        self.cli("report", "--run", "r-000000000000", "--from-json", str(published), code=2)

    def test_shipped_job_entry(self):
        from laptop import common
        entry = [j for j in common.load_jobs(ROOT) if j["id"] == "graph-runner"][0]       # the job runner's own strict reader
        self.assertEqual((entry["run"], entry["every"], entry["timeout"], entry["report"]),
                         ("graphs/runner/tick_job.py", 300, 300, True))


if __name__ == "__main__":
    unittest.main()
