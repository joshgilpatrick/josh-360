"""JP-173: each ticket's Agent Manager sessions carry a letter, the newest open one stays in view in its status group,
and Done tickets leave after 7 days (a finished step's session is closed instead: JP-191, test_runner_close_sessions). The agent-manager is a fake, the clock and tickets are made up; no real session starts."""
import json
import sqlite3
import time
import unittest

from runner_helpers import RunnerCase, db, runfolder
from runner_lib import amgroups

import binding

AM = ("--runner", "agent-manager")
MINUTE = 60
DAY = 86400


class Groups(RunnerCase):
    def setUp(self):
        super().setUp()
        self.run_id = self.start("valid", "JP-900", *AM)

    def am_row(self, session):
        conn = sqlite3.connect(str(self.am_dir / "state.db"))
        try:
            return conn.execute("SELECT name, group_name, archived FROM sessions WHERE id = ?", (session,)).fetchone()
        finally:
            conn.close()

    def spawned_names(self):
        return [c[c.index("--name") + 1] for c in self.am_calls("spawn")]

    def record(self, key="JP-900"):
        return amgroups.load()["tickets"][key]

    def set_status(self, run, status):
        """What a move-ticket gate leaves behind: the run file's `jira_status` (JP-173 reads nothing else)."""
        doc = runfolder.load(run)
        doc["jira_status"] = status
        runfolder.save(run, doc)

    def sync(self):
        conn = db.connect(db.ledger_path())
        try:
            amgroups.sync(conn, binding, self.now)
        finally:
            conn.close()

    def design_done(self, run=None):
        """The design session starts, writes its result and rests; the run parks at approve_spec."""
        run = run or self.run_id
        self.assertEqual(self.advance(run), "spawned")
        self.session_starts(run, "design")
        self.session_ends(run, "design", "ready", {"spec_path": "spec-1"})
        self.assertEqual(self.advance(run), "parked")

    # -- the scenarios -------------------------------------------------------------------------------------------

    def test_the_first_session_of_a_ticket(self):
        """Scenario: The first session of a ticket."""
        self.assertEqual(self.advance(self.run_id), "spawned")
        call = self.am_calls("spawn")[0]
        self.assertEqual(call[call.index("--name") + 1], "JP-900(a) - Design")
        self.assertEqual(call[call.index("--group") + 1], "josh-360/tickets/Design-Planning")
        self.assertEqual(self.am_row("s-1"), ("JP-900(a) - Design", "josh-360/tickets/Design-Planning", 0))
        self.assertIn(["create-group", "josh-360/tickets/Design-Planning"], self.am_calls("create-group"))
        rec = self.record()
        self.assertEqual((rec["count"], rec["status"], rec["group"]), (1, "Design/Planning", "josh-360/tickets/Design-Planning"))

    def test_letters_count_across_runs(self):
        """Scenario: Letters count across runs (3 sessions in an earlier run, 1 in this one, then the build step)."""
        for _ in range(3):
            amgroups.allocate("JP-900")                   # the earlier triage run's three sessions
        self.design_done()                                # this run's first session: (d)
        self.answer_in_app(self.run_id, "approve_spec", "build")
        self.assertEqual(self.advance(self.run_id), "spawned")
        self.assertEqual(self.spawned_names(), ["JP-900(d) - Design", "JP-900(e) - Build"])
        self.assertEqual(self.am_row("s-2")[1], "josh-360/tickets/In Progress")

    def test_a_retry_gets_its_own_letter(self):
        """Scenario: A retry gets its own letter, and the attempt it replaces is archived."""
        self.assertEqual(self.advance(self.run_id), "spawned")
        self.session_starts(self.run_id, "design")
        self.am_set("s-1", status="idle")
        self.assertEqual(self.advance(self.run_id), "working")
        self.later(11 * MINUTE)                           # rested with no result: abandoned, then tried again
        self.assertEqual(self.advance(self.run_id), "spawned")
        self.assertEqual(self.spawned_names(), ["JP-900(a) - Design", "JP-900(b) - Design"])
        self.assertEqual(self.am_row("s-1")[2], 1)
        self.assertEqual(self.am_row("s-2")[2], 0)

    def test_the_newest_session_follows_the_status(self):
        """Scenario: The newest session follows the status, and stays in view."""
        self.design_done()
        self.answer_in_app(self.run_id, "approve_spec", "build")
        self.assertEqual(self.advance(self.run_id), "spawned")
        self.assertEqual(self.am_row("s-2")[1:], ("josh-360/tickets/In Progress", 0))
        self.set_status(self.run_id, "Code Review")
        self.sync()
        self.assertEqual(self.am_row("s-2")[1:], ("josh-360/tickets/Code Review", 0))
        self.assertIn(["move", "s-2", "josh-360/tickets/Code Review", "--json"], self.am_calls("move"))
        self.assertEqual(self.am_row("s-1")[1:], ("josh-360/completed-steps", 0))   # finished: filed, killed (JP-191)
        self.sync()                                       # nothing left to do: no second move
        self.assertEqual([c for c in self.am_calls("move") if c[1] == "s-2"],
                         [["move", "s-2", "josh-360/tickets/Code Review", "--json"]])

    def test_a_recorded_result_files_the_session_away_unarchived(self):
        """JP-191 replaces JP-173's "stays in view": the row stays (not archived) but leaves the status group."""
        self.design_done()
        self.assertEqual(self.am_row("s-1")[1:], ("josh-360/completed-steps", 0))
        self.assertEqual(self.am_calls("archive"), [])

    def design_working(self):
        """The design session starts and is still at work: its step is open, so it follows the ticket's status."""
        self.assertEqual(self.advance(self.run_id), "spawned")
        self.session_starts(self.run_id, "design")
        self.assertEqual(self.advance(self.run_id), "working")

    def test_done_tickets_leave_after_7_days(self):
        """Scenario: Done tickets leave after 7 days; one that reached Done 6 days ago keeps its session."""
        other = self.start("valid", "JP-901", *AM)
        self.design_done(self.run_id)
        self.design_done(other)
        for run, days in ((self.run_id, 7 * DAY + 3600), (other, 6 * DAY)):
            self.set_status(run, "Done")
            self.end_run(run, self.now - days)
        self.sync()
        self.assertEqual(self.am_row("s-1")[2], 1)        # JP-900, 7 days and 1 hour
        self.assertEqual(self.am_row("s-2")[2], 0)        # JP-901, 6 days
        self.assertEqual(self.record("JP-901")["status"], "Done")
        self.later(DAY)
        self.sync()
        self.assertEqual(self.am_row("s-2")[2], 1)

    def test_the_tick_places_sessions(self):
        from runner_lib import tick
        self.design_working()
        self.set_status(self.run_id, "Code Review")
        tick.tick(now=lambda: self.now, launcher=lambda r: None, jira=None, root=self.root)
        self.assertEqual(self.am_row("s-1")[1], "josh-360/tickets/Code Review")

    def test_a_failed_move_is_tried_again(self):
        self.design_working()
        self.set_status(self.run_id, "Code Review")
        self.am_behaviour(move_fails=True)
        self.sync()
        self.assertEqual(self.am_row("s-1")[1], "josh-360/tickets/Design-Planning")
        self.assertEqual(self.record()["sessions"][0]["group"], "josh-360/tickets/Design-Planning")
        self.am_behaviour()
        self.sync()
        self.assertEqual(self.am_row("s-1")[1], "josh-360/tickets/Code Review")

    def test_a_status_group_that_cannot_be_made_falls_back_to_the_old_group(self):
        self.am_behaviour(create_group_fails="josh-360/tickets/")
        self.assertEqual(self.advance(self.run_id), "spawned")
        self.assertEqual(self.am_row("s-1")[1], "josh-360/graph-runs")
        self.am_behaviour()
        self.sync()                                       # the next pass makes the group and moves the session
        self.assertEqual(self.am_row("s-1")[1], "josh-360/tickets/Design-Planning")

    def test_an_unreadable_tickets_file_starts_no_session(self):
        amgroups.path().parent.mkdir(parents=True, exist_ok=True)
        amgroups.path().write_text("{not json")
        self.assertEqual(self.advance(self.run_id), "locked")
        self.assertEqual(self.am_calls("spawn"), [])

    def end_run(self, run, at):
        stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(at))
        conn = db.connect(db.ledger_path())
        try:
            conn.execute("INSERT INTO run_ends (run_id, end_name, score, version, ended_at, recorded_by) "
                         "VALUES (?, 'finished', 'success', 1, ?, 'test')", (run, stamp))
            conn.commit()
        finally:
            conn.close()


class Names(unittest.TestCase):
    def test_letters(self):
        self.assertEqual([binding.letter(n) for n in (1, 2, 26, 27, 28, 52, 53, 702, 703)],
                         ["a", "b", "z", "aa", "ab", "az", "ba", "zz", "aaa"])

    def test_ticket_names_and_groups(self):
        self.assertEqual(binding.ticket_session_name("JP-116", 3, "fix_review"), "JP-116(c) - Fix Review")
        self.assertEqual(binding.ticket_group("Design/Planning"), "josh-360/tickets/Design-Planning")
        self.assertEqual(binding.ticket_group("In Progress"), "josh-360/tickets/In Progress")
        self.assertIsNone(binding.ticket_group(None))

    def test_a_keyless_session_keeps_the_old_name(self):
        a = {"step": "read_intake", "ticket": None, "graph": "ticket-creation", "run": "r-1a2b3c4d"}
        self.assertEqual(binding.session_name(a), "ticket-creation - Read Intake (r1a2b)")
        self.assertEqual(binding.session_name(dict(a, session_name="JP-1(a) - X")), "JP-1(a) - X")


if __name__ == "__main__":
    unittest.main()
