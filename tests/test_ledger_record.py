"""JP-107, Task 5: the recorder. Made-up sessions, folders, tickets and git answers only; no network, no model."""
import calendar
import socket
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ledger_transcripts as tr  # noqa: E402
from ledger_helpers import FAKE_PHONE, NOW, ROOT, LedgerCase  # noqa: E402
from test_ledger_costs import cost_ledger, message  # noqa: E402
from test_ledger_homes import CONV  # noqa: E402
from ledger import record, spool  # noqa: E402

NOW_EPOCH = calendar.timegm(time.strptime(NOW, "%Y-%m-%dT%H:%M:%SZ"))
FOLDER = "/tmp/made-up/josh_360"
START = "2026-11-17T09:00:00Z"


def fake_git(folder, args):
    if args[0] == "rev-parse":
        return folder
    if args[0] == "remote":
        return "https://example.test/made-up/josh-360.git"
    if args[0] == "log":
        return "a" * 40 + "\n" + "b" * 40
    return None


def jira_ok(key):
    return {"epic_key": "JP-901", "initiative_key": None, "area": None, "system": None}


class Recorder(LedgerCase):
    def setUp(self):
        super().setUp()
        self.spool = self.tmp / "spool"
        self.projects = self.tmp / "projects"
        self.state = {"spool": {"file": "", "offset": 0}, "sessions": {}}

    def tfile(self, sid="sess-0001"):
        return self.projects / "-made-up" / (sid + ".jsonl")

    def start(self, sid="sess-0001", started_by="walker", at=START, folder=FOLDER, source="startup"):
        spool.append("SessionStart", {"session_id": sid, "cwd": folder, "source": source, "started_by": started_by,
                                      "transcript_path": str(self.tfile(sid))}, at, self.spool)

    def end(self, sid="sess-0001", at="2026-11-17T09:11:00Z"):
        spool.append("SessionEnd", {"session_id": sid, "reason": "other", "cwd": FOLDER, "started_by": "walker"},
                     at, self.spool)

    def run_pass(self, now=NOW, git=fake_git, jira=jira_ok, conv=CONV):
        return record.record_pass(self.conn, now=now, spool=self.spool, projects=self.projects, git=git, jira=jira,
                                  conventions=conv, state=self.state)

    def stale(self, path):
        import os
        os.utime(str(path), (NOW_EPOCH - 3600, NOW_EPOCH - 3600))

    # -- a session row exists from its start -------------------------------------------------------------------

    def test_session_row_written_at_start(self):
        """JP-148 scenario 1: a SessionStart alone, transcript still growing, gives a row and no episode."""
        self.start()
        tr.write(self.tfile(), tr.plain(FOLDER), mtime=NOW_EPOCH - 60)
        counts = self.run_pass()
        self.assertEqual(counts["sessions"], 1)
        self.assertEqual(self.rows("SELECT started_by, started_at, start_folder FROM sessions"),
                         [("walker", START, FOLDER)])
        self.assertEqual(self.count("session_episodes"), 0)
        uid = self.uid("sess-0001")
        self.conn.execute(
            "INSERT INTO graph_runs (run_id, machine_id, graph_id, graph_source, graph_version, subject_kind, "
            "subject_ref, phi, runner, started_at, recorded_by) "
            "VALUES ('r-1', ?, 'dev', 'graph-file', '1', 'intake', 'made-up', 0, 'cli', ?, 'test')",
            (self.machine, START))
        self.conn.execute(
            "INSERT INTO step_runs (run_id, step_id, step_kind, attempt, loop_count, session_uid, started_at, "
            "recorded_by) VALUES ('r-1', 'check', 'gate', 1, 0, ?, ?, 'test')", (uid, START))
        self.assertEqual(self.count("step_runs"), 1)

    # -- going quiet -------------------------------------------------------------------------------------------

    def test_quiet_session_is_recorded_with_its_facts(self):
        """JP-107 scenario 1, end to end."""
        self.start()
        self.end()
        tr.write(self.tfile(), tr.plain(FOLDER, title="Made up title", pr=("https://example.test/o/r/pull/9", "o/r"),
                                        created=["/tmp/made-up/a.md"]), mtime=NOW_EPOCH - 60)
        counts = self.run_pass()
        self.assertEqual((counts["sessions"], counts["episodes"], counts["homes"]), (1, 1, 1))
        ep = self.rows("SELECT episode, began_at, last_activity_at, quiet_at, end_reason, folder, git_root, repo, "
                       "branch, title, title_source, turns FROM session_episodes")[0]
        self.assertEqual(ep, (1, "2026-11-17T09:00:00Z", "2026-11-17T09:10:00Z", "2026-11-17T09:11:00Z",
                              "session-end", FOLDER, FOLDER, "made-up/josh-360", "JP-900/sample-work",
                              "Made up title", "ai", 3))
        refs = {(k, v) for k, v in self.rows("SELECT kind, value FROM session_refs")}
        self.assertEqual(refs, {("folder", FOLDER), ("branch", "JP-900/sample-work"), ("file", "/tmp/made-up/a.md"),
                                ("pr", "https://example.test/o/r/pull/9"), ("commit", "a" * 40),
                                ("commit", "b" * 40)})
        link = self.rows("SELECT tracker, ticket_key, relation, source FROM ticket_links")
        self.assertEqual(link, [("jira", "JP-900", "touched", "branch")])
        home = self.rows("SELECT method, ticket_key, epic_key, priority, jira_read FROM session_homes")
        self.assertEqual(home, [("branch", "JP-900", "JP-901", "epicprio", "ok")])

    def test_not_quiet_yet_writes_nothing(self):
        self.start()
        tr.write(self.tfile(), tr.plain(FOLDER), mtime=NOW_EPOCH - 600)
        counts = self.run_pass()
        self.assertEqual((counts["episodes"], self.count("session_episodes")), (0, 0))

    def test_quiet_after_thirty_minutes_without_session_end(self):
        self.start()
        tr.write(self.tfile(), tr.plain(FOLDER), mtime=NOW_EPOCH - 1801)
        self.run_pass()
        row = self.rows("SELECT end_reason, quiet_at FROM session_episodes")[0]
        self.assertEqual(row, ("quiet", "2026-11-17T09:40:00Z"))

    def test_second_pass_adds_nothing(self):
        """Review Focus 3."""
        self.start()
        self.end()
        tr.write(self.tfile(), tr.plain(FOLDER, created=["/tmp/made-up/a.md"]), mtime=NOW_EPOCH - 60)
        self.run_pass()
        before = {t: self.count(t) for t in ("sessions", "session_episodes", "session_refs", "session_homes",
                                              "ticket_links")}
        again = self.run_pass()
        self.assertEqual(again, {"sessions": 0, "episodes": 0, "refs": 0, "homes": 0, "skipped": 0, "costs": 0,
                                 "notes": 0})
        self.assertEqual(before, {t: self.count(t) for t in before})

    def test_a_lost_mark_does_not_record_the_same_stretch_twice(self):
        self.start()
        self.end()
        tr.write(self.tfile(), tr.plain(FOLDER), mtime=NOW_EPOCH - 60)
        self.run_pass()
        self.state = {"spool": {"file": "", "offset": 0}, "sessions": {}}
        self.run_pass()
        self.assertEqual(self.count("session_episodes"), 1)

    def test_resume_adds_episode_2_and_keeps_episode_1(self):
        """JP-107 scenario 4."""
        self.start()
        self.end()
        path = tr.write(self.tfile(), tr.plain(FOLDER, created=["/tmp/made-up/a.md"]), mtime=NOW_EPOCH - 7200)
        self.run_pass(now="2026-11-17T10:00:00Z")
        first = self.rows("SELECT * FROM session_episodes WHERE episode = 1")
        refs_before = self.count("session_refs")
        self.start(source="resume", at="2026-11-17T11:00:00Z")
        tr.append(path, [tr.line("user", "2026-11-17T11:01:00Z", cwd=FOLDER, gitBranch="JP-900/sample-work"),
                         tr.line("assistant", "2026-11-17T11:02:00Z", cwd=FOLDER, gitBranch="JP-900/sample-work",
                                 toolUseResult={"type": "create", "filePath": "/tmp/made-up/a.md"})],
                  mtime=NOW_EPOCH - 3000)
        self.run_pass()
        self.assertEqual(self.rows("SELECT * FROM session_episodes WHERE episode = 1"), first)
        self.assertEqual(self.rows("SELECT episode, began_at FROM session_episodes WHERE episode = 2"),
                         [(2, "2026-11-17T11:01:00Z")])
        self.assertEqual(self.count("session_refs"), refs_before)  # the same refs seen again are not duplicated

    def test_subagent_is_its_own_session_with_lineage(self):
        self.start()
        self.end()
        tr.write(self.tfile(), tr.plain(FOLDER), mtime=NOW_EPOCH - 60)
        sub = self.projects / "-made-up" / "sess-0001" / "subagents" / "agent-ab12.jsonl"
        tr.write(sub, tr.plain(FOLDER, session_id="sess-0001"), mtime=NOW_EPOCH - 60)
        self.run_pass()
        self.assertEqual(self.count("sessions"), 2)
        lineage = self.rows("SELECT child_uid, parent_uid, root_uid, kind, confidence FROM session_lineage")
        child = self.uid("sess-0001+agent-ab12")
        self.assertEqual(lineage, [(child, self.uid("sess-0001"), self.uid("sess-0001"), "subagent", "confirmed")])
        self.assertEqual(self.rows("SELECT started_by FROM sessions WHERE session_uid = ?", (child,)),
                         [("walker",)])

    # -- what a session may store ------------------------------------------------------------------------------

    def one_title(self, folder, title, sid="sess-0001"):
        self.start(sid=sid, folder=folder)
        self.end(sid=sid)
        path = self.tfile(sid)
        tr.write(path, tr.plain(folder, session_id=sid) + [tr.line("custom-title", "2026-11-17T09:09:00Z", sid,
                                                                   customTitle=title)], mtime=NOW_EPOCH - 60)
        self.run_pass()
        return self.rows("SELECT title, title_source FROM session_episodes WHERE session_uid = ?",
                         (self.uid(sid),))[0]

    def test_phi_folder_stores_no_title(self):
        self.assertEqual(self.one_title("/tmp/made-up/.phi/export", "A made-up title"), (None, "withheld"))

    def test_any_system_keeps_its_title(self):
        """JP-149: a registry system and an Unassigned folder both keep a title that passes the screen."""
        self.assertEqual(self.one_title("/Users/made-up/Dev/made-up-app/src", "Registry title", "sess-0001"),
                         ("Registry title", "custom"))
        self.assertEqual(self.one_title("/tmp/nowhere/in-particular", "Unassigned title", "sess-0002"),
                         ("Unassigned title", "custom"))

    def test_title_failing_the_screen_is_withheld(self):
        self.assertEqual(self.one_title(FOLDER, "Call " + FAKE_PHONE + " about it"), (None, "withheld"))

    def test_a_session_with_no_start_line_is_recorded_as_unknown(self):
        self.end()
        tr.write(self.tfile(), tr.plain(FOLDER), mtime=NOW_EPOCH - 60)
        self.run_pass()
        self.assertEqual(self.rows("SELECT started_by FROM sessions"), [("unknown",)])

    def test_failed_git_leaves_fields_empty(self):
        self.start()
        self.end()
        tr.write(self.tfile(), tr.plain(FOLDER), mtime=NOW_EPOCH - 60)
        self.run_pass(git=lambda folder, args: None)
        self.assertEqual(self.rows("SELECT git_root, repo FROM session_episodes"), [(None, None)])
        self.assertEqual(self.count("session_refs") > 0, True)

    def test_failed_jira_read_is_written_as_failed_not_unassigned(self):
        self.start()
        self.end()
        tr.write(self.tfile(), tr.plain(FOLDER), mtime=NOW_EPOCH - 60)
        self.run_pass(jira=lambda key: None)
        self.assertEqual(self.rows("SELECT method, jira_read FROM session_homes"), [("branch", "failed")])

    def test_one_bad_session_does_not_stop_the_others(self):
        for sid in ("sess-0001", "sess-0002"):
            self.start(sid=sid)
            self.end(sid=sid)
            tr.write(self.tfile(sid), tr.plain(FOLDER, session_id=sid), mtime=NOW_EPOCH - 60)

        def git(folder, args):
            if args[0] == "rev-parse" and getattr(git, "n", 0) == 0:
                git.n = 1
                raise RuntimeError("made-up git failure")
            return fake_git(folder, args)
        counts = self.run_pass(git=git)
        self.assertEqual((counts["episodes"], counts["skipped"]), (1, 1))

    # -- cost, notes, titles from the cost ledger, re-homing ---------------------------------------------------

    def quiet_session(self, folder=FOLDER, sid="sess-0001"):
        self.start(sid=sid, folder=folder)
        self.end(sid=sid)
        tr.write(self.tfile(sid), tr.plain(folder, session_id=sid) + [
            tr.line("system", "2026-11-17T09:09:00Z", sid, subtype="compact_boundary")], mtime=NOW_EPOCH - 60)

    def test_cost_links_notes_and_facts_are_written_with_the_episode(self):
        self.quiet_session()
        cdb = cost_ledger()
        message(cdb, 1, cost=2.0)
        cdb.execute("INSERT INTO jira_session_links VALUES ('JP-902', 'claude-code', 'sess-0001', 'worked', ?)",
                    ("2026-11-17T09:05:00Z",))
        home = self.tmp / "claude-home"
        notes = home / "session-state" / "sess-0001" / "STATE.md"
        notes.parent.mkdir(parents=True)
        notes.write_text("## U-turns\n- a -> b: because; told the user yes\n\n## Dead ends\n- x: y; do not retry\n",
                         encoding="utf-8")
        counts = record.record_pass(self.conn, now=NOW, spool=self.spool, projects=self.projects, git=fake_git,
                                    jira=jira_ok, conventions=CONV, state=self.state, cost_db=cdb, claude_home=home)
        self.assertEqual((counts["costs"], counts["notes"]), (1, 2))
        self.assertEqual(self.rows("SELECT cost_usd FROM current_session_costs"), [(2.0,)])
        self.assertEqual(self.rows("SELECT ticket_key, source FROM ticket_links ORDER BY source"),
                         [("JP-900", "branch"), ("JP-902", "jira-command")])
        self.assertEqual(self.rows("SELECT fact, value FROM session_facts ORDER BY fact"),
                         [("compactions", 1), ("dead_ends", 1), ("u_turns", 1)])

    def test_phi_folder_stores_no_notes_or_cost_ledger_title(self):
        """Review Focus 6: nothing from STATE.md, and no title from the cost ledger either."""
        folder = "/tmp/made-up/.phi/export"
        self.quiet_session(folder)
        cdb = cost_ledger()
        cdb.execute("INSERT INTO session_labels VALUES ('claude-code', 'sess-0001', 'custom_title', 'Made up', ?)",
                    (NOW,))
        home = self.tmp / "claude-home"
        notes = home / "session-state" / "sess-0001" / "STATE.md"
        notes.parent.mkdir(parents=True)
        notes.write_text("## Dead ends\n- a secret thing: failed; do not retry\n", encoding="utf-8")
        record.record_pass(self.conn, now=NOW, spool=self.spool, projects=self.projects, git=fake_git, jira=jira_ok,
                           conventions=CONV, state=self.state, cost_db=cdb, claude_home=home)
        self.assertEqual(self.count("session_state_notes"), 0)
        self.assertEqual(self.rows("SELECT title, title_source FROM session_episodes"), [(None, "withheld")])

    def test_cost_ledger_title_follows_the_same_rule(self):
        self.quiet_session()
        cdb = cost_ledger()
        cdb.execute("INSERT INTO session_labels VALUES ('claude-code', 'sess-0001', 'ai_title', 'From cost ledger', ?)",
                    (NOW,))
        record.record_pass(self.conn, now=NOW, spool=self.spool, projects=self.projects, git=fake_git, jira=jira_ok,
                           conventions=CONV, state=self.state, cost_db=cdb)
        self.assertEqual(self.rows("SELECT title, title_source FROM session_episodes"),
                         [("From cost ledger", "ai")])

    def test_cost_ledger_title_with_patient_data_is_withheld(self):
        self.quiet_session()
        cdb = cost_ledger()
        cdb.execute("INSERT INTO session_labels VALUES ('claude-code', 'sess-0001', 'ai_title', ?, ?)",
                    ("Call " + FAKE_PHONE, NOW))
        record.record_pass(self.conn, now=NOW, spool=self.spool, projects=self.projects, git=fake_git, jira=jira_ok,
                           conventions=CONV, state=self.state, cost_db=cdb)
        self.assertEqual(self.rows("SELECT title, title_source FROM session_episodes"), [(None, "withheld")])

    def test_rehome_writes_only_changed_homes(self):
        self.quiet_session()
        self.run_pass()
        self.assertEqual(record.rehome_recent(self.conn, NOW, jira_ok, CONV), {"homes": 0})
        other = lambda key: {"epic_key": "JP-999", "initiative_key": "TECH-901", "area": None, "system": None}  # noqa
        self.assertEqual(record.rehome_recent(self.conn, NOW, other, CONV), {"homes": 1})
        self.assertEqual(self.count("session_homes"), 2)
        self.assertEqual(self.rows("SELECT epic_key FROM current_homes"), [("JP-999",)])

    def test_rehome_leaves_old_sessions_alone(self):
        self.quiet_session()
        self.run_pass()
        other = lambda key: {"epic_key": "JP-999", "initiative_key": None, "area": None, "system": None}  # noqa
        self.assertEqual(record.rehome_recent(self.conn, "2026-12-30T00:00:00Z", other, CONV), {"homes": 0})

    def test_a_failed_jira_read_is_repeated_when_jira_answers(self):
        self.quiet_session()
        self.run_pass(jira=lambda key: None)
        self.assertEqual(record.rehome_recent(self.conn, NOW, lambda key: None, CONV, only_failed=True), {"homes": 0})
        self.assertEqual(record.rehome_recent(self.conn, NOW, jira_ok, CONV, only_failed=True), {"homes": 1})
        self.assertEqual(self.rows("SELECT jira_read, epic_key FROM current_homes"), [("ok", "JP-901")])
        self.assertEqual(record.rehome_recent(self.conn, NOW, jira_ok, CONV, only_failed=True), {"homes": 0})

    def test_recopy_costs_adds_a_batch_after_repricing(self):
        self.quiet_session()
        cdb = cost_ledger()
        message(cdb, 1, cost=1.0)
        record.record_pass(self.conn, now=NOW, spool=self.spool, projects=self.projects, git=fake_git, jira=jira_ok,
                           conventions=CONV, state=self.state, cost_db=cdb)
        cdb.execute("INSERT INTO pricing_runs (id, started_at) VALUES (2, 'x')")
        cdb.execute("INSERT INTO message_costs VALUES (2, 1, 'model-a', 5.0, NULL, 'priced')")
        self.assertEqual(record.recopy_costs_recent(self.conn, cdb, "2026-11-18T00:00:00Z"), {"costs": 1})
        self.assertEqual(self.rows("SELECT cost_usd FROM current_session_costs"), [(5.0,)])

    # -- no model, no network ----------------------------------------------------------------------------------

    def test_no_model_is_called(self):
        """JP-107 scenario 3."""
        self.start()
        self.end()
        tr.write(self.tfile(), tr.plain(FOLDER), mtime=NOW_EPOCH - 60)
        with mock.patch.object(socket.socket, "connect", side_effect=AssertionError("network used")), \
                mock.patch.object(socket, "create_connection", side_effect=AssertionError("network used")):
            counts = self.run_pass()
        self.assertEqual(counts["episodes"], 1)
        source = (ROOT / "ledger" / "record.py").read_text(encoding="utf-8")
        for banned in ("urllib.request", "http.client", "anthropic"):
            self.assertNotIn("import " + banned, source)
            self.assertNotIn("from " + banned, source)


if __name__ == "__main__":
    unittest.main()
