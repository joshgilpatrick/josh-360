"""JP-107, Task 7: the six read queries, against a made-up ledger."""
import io
import json
import sqlite3
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ledger_helpers import NOW, T, LedgerCase  # noqa: E402
from test_ledger_schema import PRECEDENT_SQL  # noqa: E402
from ledger import ask  # noqa: E402

SINGLE = "ticket-creation/approve;system=josh-360;type=task;shape=single;action=create"
EPIC = "ticket-creation/approve;system=josh-360;type=epic;shape=epic_with_tickets;action=create"


class Ask(LedgerCase):
    def seed_session(self, sid="sess-0001", folder="/tmp/made-up/josh_360", branch="JP-900/sample", ticket="JP-900",
                     system="josh-360", quiet="2026-11-17T10:30:00Z", repo="o/josh-360", commit=True, pr=None,
                     summary="First line of the made-up summary\nsecond line"):
        uid = self.session(sid)
        self.conn.execute(
            "INSERT INTO session_episodes (session_uid, episode, began_at, last_activity_at, quiet_at, end_reason, "
            "folder, repo, branch, title, title_source, recorded_at, recorded_by) "
            "VALUES (?, 1, ?, ?, ?, 'quiet', ?, ?, ?, ?, 'ai', ?, 'test')",
            (uid, T, T, quiet, folder, repo, branch, "Title " + sid, T))
        self.conn.execute(
            "INSERT INTO session_homes (session_uid, episode, method, tracker, ticket_key, epic_key, system, "
            "priority, evidence, conventions_version, jira_read, derived_at, recorded_by) "
            "VALUES (?, 1, 'branch', 'jira', ?, 'JP-901', ?, 'epicprio', 'e', 'abc', 'ok', ?, 'test')",
            (uid, ticket, system, T))
        self.conn.execute("INSERT INTO ticket_links (session_uid, tracker, ticket_key, relation, source, linked_at, "
                          "recorded_by) VALUES (?, 'jira', ?, 'touched', 'branch', ?, 'test')", (uid, ticket, T))
        if commit:
            self.conn.execute("INSERT INTO session_refs (session_uid, episode, kind, repo, value, source, observed_at, "
                              "recorded_at, recorded_by) VALUES (?, 1, 'commit', ?, ?, 'git', ?, ?, 'test')",
                              (uid, repo, sid.replace("-", "")[:7].ljust(7, "a"), T, T))
        if pr:
            self.conn.execute("INSERT INTO session_refs (session_uid, episode, kind, repo, value, source, observed_at, "
                              "recorded_at, recorded_by) VALUES (?, 1, 'pr', ?, ?, 'transcript', ?, ?, 'test')",
                              (uid, repo, pr, T, T))
        if summary:
            self.conn.execute("INSERT INTO session_summaries (session_uid, episode, method, lines, written_at, "
                              "recorded_by) VALUES (?, 1, 'copied', ?, ?, 'test')", (uid, summary, T))
        return uid

    def seed_run(self, ticket="JP-900"):
        self.conn.execute(
            "INSERT INTO graph_runs (run_id, machine_id, graph_id, graph_source, graph_version, subject_kind, "
            "subject_ref, tracker, ticket_key, phi, runner, started_at, recorded_by) "
            "VALUES ('run-1', ?, 'triage', 'graph-file', 'abc', 'ticket', ?, 'jira', ?, 0, 'cli', ?, 'test')",
            (self.machine, ticket, ticket, "2026-11-17T09:00:00Z"))
        self.conn.execute("INSERT INTO step_runs (run_id, step_id, step_kind, attempt, loop_count, tier, role, "
                          "started_at, recorded_by) VALUES ('run-1', 'sign_off', 'role', 1, 0, 'mid', 'r', ?, 't')",
                          ("2026-11-17T09:01:00Z",))
        self.conn.execute("INSERT INTO step_results (step_run_id, outcome, model, ended_at, recorded_by) "
                          "VALUES (1, 'ready', 'm', ?, 't')", ("2026-11-17T09:02:00Z",))
        self.conn.execute("INSERT INTO run_ends (run_id, end_name, score, ended_at, recorded_by) "
                          "VALUES ('run-1', 'finished', 'success', ?, 't')", ("2026-11-17T09:03:00Z",))

    def decision(self, category, answer="approve", system="josh-360", work_type="code", ticket="JP-900"):
        return self.conn.execute(
            "INSERT INTO decisions (category, question_key, system, work_type, tracker, ticket_key, answer, how, "
            "decided_by, decided_at, recorded_by) VALUES (?, 'ticket-creation/approve', ?, ?, 'jira', ?, ?, "
            "'answered', 'josh', ?, 'test')", (category, system, work_type, ticket, answer, T)).lastrowid

    def call(self, argv):
        out = io.StringIO()
        code = ask.main(argv, out, self.path)
        return code, (json.loads(out.getvalue()) if out.getvalue() else None), out.getvalue()

    # -- the six queries ---------------------------------------------------------------------------------------

    def test_home_by_either_id(self):
        uid = self.seed_session()
        for ident in (uid, "sess-0001"):
            code, body, _ = self.call(["home", "--session", ident])
            self.assertEqual(code, 0)
            self.assertEqual(body["rows"], [{"session_uid": uid, "ticket_key": "JP-900", "tracker": "jira",
                                             "epic_key": "JP-901", "system": "josh-360", "method": "branch"}])

    def test_home_never_returns_priority(self):
        self.seed_session()
        _, body, raw = self.call(["home", "--session", "sess-0001"])
        self.assertNotIn("priority", raw)
        self.assertNotIn("epicprio", raw)

    def test_ticket_lists_sessions_and_runs(self):
        uid = self.seed_session()
        self.seed_run()
        _, body, _ = self.call(["ticket", "--key", "JP-900"])
        kinds = {r["kind"]: r for r in body["rows"]}
        self.assertEqual(set(kinds), {"session", "run"})
        self.assertEqual(kinds["session"]["id"], uid)
        self.assertEqual(kinds["session"]["summary_line"], "First line of the made-up summary")
        self.assertEqual((kinds["run"]["graph"], kinds["run"]["ended"]), ("triage", "finished"))
        self.assertEqual(self.call(["ticket", "--key", "JP-999"])[1]["rows"], [])

    def test_find_by_folder_includes_subfolders_and_not_lookalikes(self):
        self.seed_session("sess-0001", folder="/tmp/made-up/josh_360")
        self.seed_session("sess-0002", folder="/tmp/made-up/josh_360/sub")
        self.seed_session("sess-0003", folder="/tmp/made-up/josh_360-old")
        _, body, _ = self.call(["find", "--folder", "/tmp/made-up/josh_360/"])
        self.assertEqual(sorted(r["session_uid"] for r in body["rows"]),
                         sorted([self.uid("sess-0001"), self.uid("sess-0002")]))

    def test_find_by_branch_and_since(self):
        self.seed_session("sess-0001", branch="JP-900/a", quiet="2026-11-10T00:00:00Z")
        self.seed_session("sess-0002", branch="JP-900/a", quiet="2026-11-17T00:00:00Z")
        _, body, _ = self.call(["find", "--branch", "JP-900/a", "--since", "2026-11-15"])
        self.assertEqual([r["session_uid"] for r in body["rows"]], [self.uid("sess-0002")])
        self.assertEqual(body["rows"][0]["ticket"], "JP-900")

    def test_precedent_returns_current_decisions_of_exactly_that_category(self):
        first = self.decision(SINGLE, "approve")
        self.decision(SINGLE, "other system", system="another")
        code, body, _ = self.call(["precedent", "--category", SINGLE, "--system", "josh-360", "--work-type", "code"])
        self.assertEqual([r["id"] for r in body["rows"]], [first])
        self.assertEqual(set(body["rows"][0]), {"id", "answer", "decided_at", "ticket_key"})

    def test_precedent_writes_a_lookup_row_and_skips_superseded(self):
        old = self.decision(SINGLE, "old answer")
        new = self.conn.execute(
            "INSERT INTO decisions (category, question_key, system, work_type, answer, how, decided_by, "
            "supersedes_decision_id, decided_at, recorded_by) VALUES (?, 'q', 'josh-360', 'code', 'new answer', "
            "'recorded', 'josh', ?, '2026-11-17T11:00:00Z', 'test')", (SINGLE, old)).lastrowid
        _, body, _ = self.call(["precedent", "--category", SINGLE, "--system", "josh-360", "--work-type", "code"])
        self.assertEqual([r["id"] for r in body["rows"]], [new])
        self.assertEqual(self.rows("SELECT category, found, system, work_type FROM memory_lookups"),
                         [(SINGLE, 1, "josh-360", "code")])

    def test_precedent_stays_inside_its_category(self):
        """JP-148 scenario 4."""
        self.decision(SINGLE)
        _, body, _ = self.call(["precedent", "--category", EPIC, "--system", "josh-360", "--work-type", "code"])
        self.assertEqual(body["rows"], [])
        self.assertEqual(self.rows("SELECT category, found FROM memory_lookups"), [(EPIC, 0)])

    def test_precedent_sql_is_the_spec_query(self):
        self.assertEqual(ask.PRECEDENT_SQL, PRECEDENT_SQL)

    def test_run_shows_the_steps_so_far(self):
        self.seed_run()
        _, body, raw = self.call(["run", "--run", "run-1"])
        self.assertEqual(len(body["rows"]), 1)
        self.assertEqual((body["rows"][0]["step"], body["rows"][0]["outcome"], body["rows"][0]["attempt"]),
                         ("sign_off", "ready", 1))
        self.assertNotIn("cost", raw)

    def test_changes_lists_only_sessions_with_commits_or_prs(self):
        with_commit = self.seed_session("sess-0001", commit=True)
        self.seed_session("sess-0002", commit=False)
        with_pr = self.seed_session("sess-0003", commit=False, pr="https://example.test/o/r/pull/9")
        _, body, _ = self.call(["changes", "--system", "josh-360", "--since", "2026-11-01"])
        self.assertEqual(sorted(r["session_uid"] for r in body["rows"]), sorted([with_commit, with_pr]))
        pr_row = [r for r in body["rows"] if r["session_uid"] == with_pr][0]
        self.assertEqual(pr_row["pull_request"], "https://example.test/o/r/pull/9")
        self.assertEqual(pr_row["summary_line"], "First line of the made-up summary")
        _, by_repo, _ = self.call(["changes", "--repo", "o/josh-360"])
        self.assertEqual(len(by_repo["rows"]), 2)

    def test_changes_live_says_not_built_yet(self):
        self.seed_session()
        _, body, _ = self.call(["changes", "--system", "josh-360", "--live"])
        self.assertEqual(body["live"], "not built yet (JP-109)")

    # -- limits and the shape of every answer ------------------------------------------------------------------

    def test_answers_are_capped(self):
        for n in range(30):
            self.seed_session("sess-%04d" % n, summary="x" * 150)
        code, body, raw = self.call(["find", "--folder", "/tmp/made-up/josh_360"])
        self.assertLessEqual(len(body["rows"]), 20)
        self.assertLessEqual(len(raw.encode("utf-8")) - 1, 4096)
        self.assertTrue(body["truncated"])
        for row in body["rows"]:
            self.assertEqual(row["summary_line"], "x" * 150)  # whole rows are dropped, never strings cut

    def test_no_query_returns_friction_cost_or_measures(self):
        uid = self.seed_session(pr="https://example.test/o/r/pull/9")
        self.seed_run()
        self.conn.execute("INSERT INTO session_facts (session_uid, episode, fact, value, recorded_at, recorded_by) "
                          "VALUES (?, 1, 'compactions', 2, ?, 't')", (uid, T))
        self.conn.execute("INSERT INTO session_costs (session_uid, computed_at, model, cost_usd, pricing_status, "
                          "price_set, recorded_by) VALUES (?, ?, 'm', 9.99, 'priced', '1', 't')", (uid, NOW))
        self.decision(SINGLE)
        banned = ("fact", "usage", "debrief", "cost", "priority", "score", "tokens")
        calls = [["home", "--session", "sess-0001"], ["ticket", "--key", "JP-900"],
                 ["find", "--folder", "/tmp/made-up/josh_360"], ["run", "--run", "run-1"],
                 ["precedent", "--category", SINGLE, "--system", "josh-360", "--work-type", "code"],
                 ["changes", "--system", "josh-360"]]
        for argv in calls:
            code, body, raw = self.call(argv)
            self.assertEqual(code, 0, argv)
            for row in body["rows"]:
                for key in row:
                    self.assertFalse(any(b in key for b in banned), (argv, key))
            self.assertNotIn("9.99", raw)

    def test_unknown_query_exits_2(self):
        with self.assertRaises(SystemExit) as caught:
            ask.main(["frobnicate"], io.StringIO(), self.path)
        self.assertEqual(caught.exception.code, 2)
        with self.assertRaises(SystemExit) as caught:
            ask.main(["find"], io.StringIO(), self.path)
        self.assertEqual(caught.exception.code, 2)

    def test_missing_ledger_exits_2_and_creates_nothing(self):
        missing = self.tmp / "none" / "ledger.db"
        self.assertEqual(ask.main(["home", "--session", "x"], io.StringIO(), missing), 2)
        self.assertFalse(missing.exists())

    def test_opens_read_only(self):
        conn = ask.open_read_only(self.path)
        self.addCleanup(conn.close)
        with self.assertRaises(sqlite3.OperationalError):
            conn.execute("INSERT INTO machines (machine_id, label, created_at, recorded_by) "
                         "VALUES ('m-00000000', 'x', 'y', 'z')")
        self.assertEqual(self.count("memory_lookups"), 0)


if __name__ == "__main__":
    unittest.main()
