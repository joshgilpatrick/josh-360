"""JP-191: a graph step's session is closed once its step is finished. It is filed in `josh-360/completed-steps` and
killed (its row kept), and archived 7 days later; a finished ticket's last session closes the ticket out through the
`close-out` gate. The agent-manager and Jira are fakes, the tickets and the clock made up; no real session starts."""
import json
import sqlite3
import time
import unittest

from runner_helpers import RunnerCase, db, runfolder
from runner_lib import amgroups

import binding

AM = ("--runner", "agent-manager")
COMPLETED = "josh-360/completed-steps"
DAY = 86400


class CloseSessions(RunnerCase):
    def setUp(self):
        super().setUp()
        self.run_id = self.start("valid", "JP-900", *AM)

    # -- helpers -------------------------------------------------------------------------------------------------

    def am_row(self, session):
        conn = sqlite3.connect(str(self.am_dir / "state.db"))
        try:
            return conn.execute("SELECT group_name, status, archived FROM sessions WHERE id = ?", (session,)).fetchone()
        finally:
            conn.close()

    def record(self, key="JP-900"):
        return amgroups.load()["tickets"][key]

    def set_status(self, run, status):
        doc = runfolder.load(run)
        doc["jira_status"] = status
        runfolder.save(run, doc)

    def end_run(self, run, at):
        stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(at))
        conn = db.connect(db.ledger_path())
        try:
            conn.execute("INSERT INTO run_ends (run_id, end_name, score, version, ended_at, recorded_by) "
                         "VALUES (?, 'finished', 'success', 1, ?, 'test')", (run, stamp))
            conn.commit()
        finally:
            conn.close()

    def sync(self):
        conn = db.connect(db.ledger_path())
        try:
            amgroups.sync(conn, binding, self.now)
        finally:
            conn.close()

    def design_done(self, run=None, rests=True):
        """The design session starts and writes its result (and comes to rest, unless `rests` is False)."""
        run = run or self.run_id
        self.assertEqual(self.advance(run), "spawned")
        self.session_starts(run, "design")
        self.session_ends(run, "design", "ready", {"spec_path": "spec-1"})
        if not rests:
            self.am_set(self.session_doc(run)["handle"]["am_session"], status="working")
        self.assertEqual(self.advance(run), "parked")

    def jira_status(self, key="JP-900"):
        return json.loads(self.jira_file().read_text())["issues"][key]["fields"]["status"]["name"]

    def transitions(self):
        return [c for c in self.jira_calls() if "transitions" in str(c.get("path") or c.get("url") or "")
                and (c.get("method") == "POST")]

    def finished_ticket(self, jira_status):
        """JP-900's design step is its last: recorded, the run ended in Done; Jira holds `jira_status`."""
        self.jira_issue("JP-900", status=jira_status)
        self.design_done()
        self.set_status(self.run_id, "Done")
        self.end_run(self.run_id, self.now)
        self.sync()

    # -- the scenarios -------------------------------------------------------------------------------------------

    def test_a_finished_steps_session_is_filed_and_killed(self):
        """Scenario: A finished step's session is filed and killed (the ticket is not finished)."""
        self.design_done()
        self.assertEqual(self.am_row("s-1"), (COMPLETED, "dead", 0))
        self.assertIn(["kill", "s-1", "--json"], self.am_calls("kill"))
        self.assertIn(["create-group", COMPLETED], self.am_calls("create-group"))
        entry = self.record()["sessions"][0]
        self.assertTrue(entry["killed"])
        self.assertEqual((entry["finished_at"], entry["filed_at"], entry["group"]), (self.now, self.now, COMPLETED))
        self.assertEqual(self.am_calls("archive"), [])

    def test_a_running_steps_session_is_left_alone(self):
        """Scenario: A running step's session is left alone."""
        self.assertEqual(self.advance(self.run_id), "spawned")
        self.session_starts(self.run_id, "design")
        for _ in range(2):
            self.assertEqual(self.advance(self.run_id), "working")
            self.sync()
            self.later(3600)
        self.assertEqual(self.am_calls("kill") + self.am_calls("archive") + self.am_calls("move"), [])
        self.assertEqual(self.am_row("s-1"), ("josh-360/tickets/Design-Planning", "working", 0))

    def test_a_session_still_at_work_is_killed_only_after_the_grace(self):
        """A result recorded while the agent is still finishing its turn: filed at once, killed after 30 minutes."""
        self.design_done(rests=False)
        self.assertEqual(self.am_row("s-1"), (COMPLETED, "working", 0))
        self.later(29 * 60)
        self.sync()
        self.assertEqual(self.am_calls("kill"), [])
        self.later(2 * 60)
        self.sync()
        self.assertEqual(self.am_row("s-1")[1], "dead")

    def test_a_refused_kill_is_tried_again(self):
        self.am_behaviour(kill_fails=True)
        self.design_done()
        self.assertEqual(self.am_row("s-1"), (COMPLETED, "idle", 0))
        self.assertFalse(self.record()["sessions"][0].get("killed"))
        self.am_behaviour()
        self.sync()
        self.assertEqual(self.am_row("s-1")[1], "dead")

    def test_the_last_session_of_a_finished_ticket_moves_it_to_done(self):
        """Scenario: The last session of a finished ticket moves it to Done (through the close-out gate)."""
        self.finished_ticket("Code Review")
        self.assertEqual(self.jira_status(), "Done")
        self.assertEqual(self.am_row("s-1"), ("josh-360/tickets/Done", "dead", 0))
        self.assertIsNotNone(self.record()["closed_out"])
        moves = len(self.transitions())
        self.later(3600)
        self.sync()                                          # once only
        self.assertEqual(len(self.transitions()), moves)

    def test_the_close_out_leaves_a_done_ticket_alone(self):
        self.finished_ticket("Done")
        self.assertEqual(self.transitions(), [])
        self.assertIsNotNone(self.record()["closed_out"])

    def test_the_close_out_never_moves_a_deployed_ticket(self):
        """A ticket in Deployed is being watched: the validation graph moves it, never this gate."""
        self.finished_ticket("Deployed")
        self.assertEqual(self.jira_status(), "Deployed")
        self.assertEqual(self.transitions(), [])

    def test_a_ticket_in_deployed_has_no_last_session(self):
        """The run ended with the ticket in Deployed: its validation is not complete, so the session waits in
        completed-steps and no close-out runs."""
        self.jira_issue("JP-900", status="Deployed")
        self.design_done()
        self.set_status(self.run_id, "Deployed")
        self.end_run(self.run_id, self.now)
        self.sync()
        self.assertEqual(self.am_row("s-1"), (COMPLETED, "dead", 0))
        self.assertIsNone(self.record()["closed_out"])

    def test_a_failed_close_out_is_tried_again(self):
        self.design_done()                                   # JP-900 is not in the fake Jira yet: the gate fails
        self.set_status(self.run_id, "Done")
        self.end_run(self.run_id, self.now)
        self.sync()
        self.assertIsNone(self.record()["closed_out"])
        self.jira_issue("JP-900", status="Validation")
        self.sync()
        self.assertEqual(self.jira_status(), "Done")
        self.assertIsNotNone(self.record()["closed_out"])

    def test_a_completed_steps_session_is_archived_after_7_days(self):
        """Scenario: filed 7 days and 1 hour ago is archived; filed 6 days ago is not."""
        other = self.start("valid", "JP-901", *AM)
        self.design_done(self.run_id)
        self.later(DAY + 3600)
        self.design_done(other)
        self.later(6 * DAY)
        from runner_lib import tick
        tick.tick(now=lambda: self.now, launcher=lambda r: None, jira=None, root=self.root)
        self.assertEqual(self.am_row("s-1")[2], 1)           # JP-900: 7 days and 1 hour
        self.assertEqual(self.am_row("s-2")[2], 0)           # JP-901: 6 days
        self.later(DAY)
        self.sync()
        self.assertEqual(self.am_row("s-2")[2], 1)

    def test_the_last_session_leaves_7_days_after_done(self):
        self.finished_ticket("Done")
        self.later(7 * DAY + 3600)
        self.sync()
        self.assertEqual(self.am_row("s-1")[2], 1)

    def test_a_recorded_session_the_finish_missed_is_closed_by_the_sync(self):
        """`finish` could not take the file's lock: the next sync reads the session file and closes it."""
        real = amgroups.finish
        amgroups.finish = lambda *a, **k: (_ for _ in ()).throw(amgroups.Busy("am-tickets.lock"))
        try:
            self.design_done()
        finally:
            amgroups.finish = real
        self.sync()
        self.assertEqual(self.am_row("s-1"), (COMPLETED, "dead", 0))

    def test_a_session_from_before_jp_191_is_not_closed(self):
        """Not in scope: a session recorded before this shipped (its session file has no `closes`) is left as it is."""
        real = amgroups.finish, amgroups.sync_run
        amgroups.finish = amgroups.sync_run = lambda *a, **k: None
        try:
            self.design_done()
        finally:
            amgroups.finish, amgroups.sync_run = real
        from runner_lib import sessionfile
        doc = self.session_doc(self.run_id)
        doc.pop("closes")
        sessionfile.write(self.run_id, "design", 1, doc)
        self.sync()
        self.assertEqual(self.am_row("s-1"), ("josh-360/tickets/Design-Planning", "idle", 0))
        self.assertEqual(self.am_calls("kill"), [])

    def test_a_keyless_session_is_archived_on_its_result_as_before(self):
        """Scenario: A keyless session is archived on its result as before (never killed or filed)."""
        run = self.walker("start", "--graph", "valid", "--subject-kind", "intake", "--subject-ref", "todo-1",
                          "--input", "system=sample", "--input", "ticket_key=none", *AM)["run"]
        self.assertEqual(self.advance(run), "spawned")
        self.session_starts(run, "design")
        self.session_ends(run, "design", "ready", {"spec_path": "spec-1"})
        self.assertEqual(self.advance(run), "parked")
        self.assertEqual(self.am_calls("archive"), [["archive", "s-1"]])
        self.assertEqual(self.am_calls("kill"), [])
        self.assertEqual(self.am_row("s-1")[0], "josh-360/graph-runs")


if __name__ == "__main__":
    unittest.main()
