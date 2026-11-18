"""JP-117, Task 11: the runner's snapshot and run report (counts, ids, step names, times) and its notifications."""
import json
import time
import unittest
from unittest import mock

from runner_helpers import RunnerCase, db, runfolder
from runner_lib import notify, paths, status

AM = ("--runner", "agent-manager")
PENDING = {"outcome": "pending", "summary": "waiting on a person"}


class Reporting(RunnerCase):
    def conn(self):
        return db.connect(db.ledger_path())

    def snap(self, now=None):
        conn = self.conn()
        try:
            return status.snapshot(conn, time.time() if now is None else now, self.root)
        finally:
            conn.close()

    def report(self, run):
        conn = self.conn()
        try:
            return status.run_report(conn, run, self.root)
        finally:
            conn.close()

    def four_runs(self):
        working = self.start("valid", "JP-901", *AM)
        self.fake_spawn(working)
        parked = self.start("valid", "JP-902", *AM)
        self.do_role(parked, "design", "ready", {"spec_path": "spec-1"})
        self.assertEqual(self.walker("next", "--run", parked)["step"], "approve_spec")
        self.plan({"lint-spec": ["crash"], "pr-state": [PENDING]})
        waiting = self.start("waits", "JP-903", *AM)
        self.do_role(waiting, "zeta", "ready", {"note": "n"})
        self.do_role(waiting, "alpha", "done", {"note": "n"})
        self.assertEqual(self.walker("next", "--run", waiting)["action"], "waiting")
        stopped = self.start("valid", "JP-904", *AM)
        self.do_role(stopped, "design", "ready", {"spec_path": "spec-1"})
        self.assertEqual(self.walker("next", "--run", stopped)["action"], "stopped")
        return working, parked, waiting, stopped

    def finished_run(self, summary="made-up"):
        run = self.start("valid", "JP-905", *AM)
        self.plan({"lint-spec": [{"outcome": "pass", "summary": summary}]})
        model = {"session": "sess-0001", "model": "claude-sonnet-5-5"}
        self.do_role(run, "design", "ready", {"spec_path": summary}, **model)
        self.assertEqual(self.walker("next", "--run", run)["step"], "approve_spec")
        self.answer_in_app(run, "approve_spec", "build")
        self.do_role(run, "build", "done", **model)
        self.do_role(run, "review", "pass", **model)
        self.do_role(run, "publish", "opened", {"pr_url": "https://example.test/pr/1"}, **model)
        self.assertEqual(self.walker("next", "--run", run)["step"], "approve_note")
        self.answer_in_app(run, "approve_note", "post")
        self.do_role(run, "post_note", "posted", **model)
        self.assertEqual(self.walker("next", "--run", run)["action"], "done")
        return run

    def test_snapshot_states(self):
        working, parked, waiting, stopped = self.four_runs()
        snap = self.snap()
        self.assertEqual(snap["runs"], {"open": 4, "working": 1, "queued": 0, "parked": 1, "waiting": 1, "stopped": 1,
                                        "between": 0})
        rows = {r["run"]: r for r in snap["open_runs"]}
        self.assertEqual((rows[working]["step"], rows[working]["state"]), ("design", "working"))
        self.assertEqual((rows[parked]["step"], rows[parked]["state"]), ("approve_spec", "parked"))
        self.assertEqual((rows[waiting]["step"], rows[waiting]["state"]), ("hold", "waiting"))
        self.assertEqual(rows[stopped]["state"], "stopped")
        self.assertEqual(snap["stopped"], [{"run": stopped, "ticket": "JP-904", "step": rows[stopped]["step"]}])
        self.assertEqual((snap["status"], snap["host"], snap["rails"], snap["sessions_live"], snap["session_limit"]),
                         ("ok", "job", True, 1, 2))

    def test_a_role_step_with_no_live_session_is_queued(self):
        run = self.start("valid", "JP-901", *AM)
        self.assertEqual(self.snap()["open_runs"][0]["state"], "between")          # no step has been asked for yet
        self.assertEqual(self.walker("next", "--run", run)["step"], "design")
        self.assertEqual(self.snap()["open_runs"][0]["state"], "queued")
        self.assertEqual(self.snap()["runs"]["queued"], 1)
        self.assertEqual(run, self.snap()["open_runs"][0]["run"])

    def test_a_run_whose_folder_is_gone_is_listed_as_unreadable(self):
        run = self.start("valid", "JP-901", *AM)
        (runfolder.folder(run) / "run.json").unlink()
        self.assertEqual(self.snap()["open_runs"][0]["state"], "unreadable")

    def test_runs_of_other_runners_are_not_listed(self):
        self.start("valid", "JP-901")                         # runner "cli"
        self.assertEqual(self.snap()["runs"]["open"], 0)

    def test_the_off_switch_and_missing_rails_show(self):
        paths.off_file().parent.mkdir(parents=True, exist_ok=True)
        paths.off_file().write_text("")
        self.write_claude_settings(without="Stop")
        snap = self.snap()
        self.assertEqual((snap["status"], snap["rails"]), ("off", False))

    def test_waits_over_seven_days_are_listed(self):
        self.plan({"pr-state": [PENDING]})
        old, recent = (self.start("waits", key, *AM) for key in ("JP-903", "JP-906"))
        for run in (old, recent):
            self.do_role(run, "zeta", "ready", {"note": "n"})
            self.do_role(run, "alpha", "done", {"note": "n"})
            self.assertEqual(self.walker("next", "--run", run)["action"], "waiting")
        now = time.time()
        for run, days in ((old, 8), (recent, 6)):
            doc = runfolder.load(run)
            doc["waiting"]["since"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - days * 86400))
            runfolder.save(run, doc)
        flagged = self.snap(now)["waiting_over_7_days"]
        self.assertEqual([(f["run"], f["ticket"], f["step"]) for f in flagged], [(old, "JP-903", "hold")])

    def test_run_report_has_every_step(self):
        run = self.finished_run()
        report = self.report(run)
        self.assertEqual((report["graph"], report["ticket"], report["runner"], report["end"], report["score"]),
                         ("valid", "JP-905", "agent-manager", "finished", "success"))
        names = [s["step"] for s in report["steps"]]
        for step in ("design", "approve_spec", "build", "review", "publish", "approve_note", "post_note"):
            self.assertIn(step, names)
        for row in report["steps"]:
            self.assertIsNotNone(row["outcome"], row)
            self.assertIsNotNone(row["loop_count"], row)
            if row["kind"] == "role":
                self.assertEqual(row["session"], "sess-0001", row)
                self.assertEqual(row["model"], "claude-sonnet-5-5", row)
                self.assertIsNotNone(row["tier"], row)
        build = [s for s in report["steps"] if s["step"] == "build"][0]
        self.assertEqual(build["jira_status"], "In Progress")

    def test_an_abandoned_attempt_names_its_sessions_and_why_it_ended(self):
        run = self.start("valid", "JP-906", *AM)
        self.assertEqual(self.advance(run), "spawned")
        self.session_starts(run, "design", session_id="cc-gone")
        self.am_set("s-1", archived=1)
        self.assertEqual(self.advance(run), "spawned")             # attempt 1 abandoned, attempt 2 spawned
        design = [s for s in self.report(run)["steps"] if s["step"] == "design"]
        first, second = design[0], design[1]
        self.assertEqual((first["attempt"], first["outcome"]), (1, "_abandoned"))
        self.assertEqual((first["session"], first["am_session"], first["reason"]), ("cc-gone", "s-1", "session-gone"))
        self.assertEqual((second["attempt"], second["am_session"], second["reason"]), (2, "s-2", None))

    def test_an_attempt_that_never_started_has_a_reason_and_no_session(self):
        run = self.start("valid", "JP-907", *AM)
        self.write_session(run, "spawning")
        self.later(10 * 60)
        self.advance(run)
        first = [s for s in self.report(run)["steps"] if s["step"] == "design"][0]
        self.assertEqual((first["session"], first["am_session"], first["reason"]), (None, None, "never-started"))

    def test_an_unreadable_session_file_does_not_stop_the_report(self):
        run = self.start("valid", "JP-908", *AM)
        self.assertEqual(self.advance(run), "spawned")
        from runner_lib import sessionfile
        sessionfile.path(run, "design", 1).write_text("{not json")
        first = [s for s in self.report(run)["steps"] if s["step"] == "design"][0]
        self.assertEqual((first["am_session"], first["reason"]), (None, "unreadable"))

    def test_report_for_a_run_that_does_not_exist_is_refused(self):
        with self.assertRaises(ValueError):
            self.report("r-000000000000")

    def test_ended_runs_reach_the_snapshot_for_the_proof_page(self):
        run = self.finished_run()
        ended = self.snap()["ended_runs"]
        self.assertEqual([e["run"] for e in ended], [run])
        self.assertEqual(ended[0]["steps"], self.report(run)["steps"])
        self.assertEqual(self.snap(time.time() + 15 * 86400)["ended_runs"], [])     # older than ended_runs_days

    def test_report_holds_no_text_from_the_run(self):
        run = self.finished_run(summary="ZEBRA")
        waiting = self.start("waits", "JP-903", *AM)
        self.do_role(waiting, "zeta", "ready", {"note": "ZEBRA"})
        self.assertNotIn("ZEBRA", json.dumps(self.snap()))
        self.assertNotIn("ZEBRA", json.dumps(self.report(run)))
        self.assertNotIn("ZEBRA", status.text(self.snap()))
        self.assertNotIn("ZEBRA", status.render(self.report(run)))

    def test_render_is_a_table(self):
        run = self.finished_run()
        report = self.report(run)
        out = status.render(report)
        self.assertTrue(out.startswith("# JP-905 · valid · " + run))
        header = [l for l in out.splitlines() if l.startswith("| Step")][0]
        self.assertEqual([c.strip() for c in header.strip("|").split("|")],
                         ["Step", "Kind", "Attempt", "Loops", "Tier", "Model", "Session", "Agent Manager session",
                          "Outcome", "Why it ended", "Jira status", "Started", "Ended"])
        rows = [l for l in out.splitlines() if l.startswith("| ") and not l.startswith(("| Step", "| ---"))]
        self.assertEqual(len(rows), len(report["steps"]))
        self.assertIn("finished", out)

    def test_text_lists_open_runs_stops_and_long_waits(self):
        working, parked, waiting, stopped = self.four_runs()
        doc = runfolder.load(waiting)
        doc["waiting"]["since"] = "2026-01-01T00:00:00Z"
        runfolder.save(waiting, doc)
        out = status.text(self.snap())
        self.assertIn("JP-901 valid design working since", out)
        self.assertIn("JP-902 valid approve_spec parked since", out)
        self.assertIn("Stopped: JP-904", out)
        self.assertIn("Waiting more than 7 days\nJP-903 hold since 2026-01-01T00:00:00Z", out)

    def test_report_from_the_published_json(self):
        run = self.finished_run()
        published = json.loads(json.dumps(self.snap()))
        self.assertEqual(status.render(status.report_from_snapshot(published, run)), status.render(self.report(run)))
        with self.assertRaises(ValueError):
            status.report_from_snapshot(published, "r-000000000000")


class Notifying(RunnerCase):
    def test_note_once(self):
        run = self.start("valid", "JP-901", *AM)
        self.assertTrue(notify.note_once(run, "stopped:build"))
        self.assertFalse(notify.note_once(run, "stopped:build"))
        self.assertTrue(notify.note_once(run, "done"))
        notify.forget_stops(run)
        self.assertTrue(notify.note_once(run, "stopped:build"))
        self.assertFalse(notify.note_once(run, "done"))

    def test_first_note_tells_josh_in_words(self):
        run = self.start("valid", "JP-901", *AM)
        with mock.patch.object(notify, "notify") as told:
            notify.note_once(run, "stopped:build")
            notify.note_once(run, "stopped:build")
            notify.note_once(run, "done")
        self.assertEqual([c.args for c in told.call_args_list],
                         [("Josh 360 runner", "JP-901: the valid run stopped at build."),
                          ("Josh 360 runner", "JP-901: the valid run ended.")])

    def test_notify_is_off_in_tests(self):
        with mock.patch.object(notify.subprocess, "run") as ran:
            self.assertFalse(notify.notify("a", "b"))
        ran.assert_not_called()

    def test_notify_escapes_and_asks_osascript(self):
        import os
        os.environ.pop("JOSH360_NO_NOTIFY")
        with mock.patch.object(notify.sys, "platform", "darwin"), mock.patch.object(notify.subprocess, "run") as ran:
            ran.return_value.returncode = 0
            self.assertTrue(notify.notify('a "t"', 'it\\s "b"'))
            argv = ran.call_args.args[0]
        self.assertEqual(argv[:2], ["/usr/bin/osascript", "-e"])
        self.assertEqual(argv[2], 'display notification "it\\\\s \\"b\\"" with title "a \\"t\\""')
        with mock.patch.object(notify.sys, "platform", "darwin"), mock.patch.object(notify.subprocess, "run",
                                                                                  side_effect=OSError("no")):
            self.assertFalse(notify.notify("a", "b"))


if __name__ == "__main__":
    unittest.main()
