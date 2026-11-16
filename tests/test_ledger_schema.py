"""JP-99: the draft ledger schema loads and keeps the design's promises.

Runs on made-up rows only, with the standard library (sqlite3). See docs/design/data-model.md.
"""
import json
import re
import sqlite3
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCHEMA = ROOT / "ledger" / "schema.sql"
CODES = ROOT / "ledger" / "codes.json"

T = "2026-11-16T10:00:00Z"
M = "m-1a2b3c4d"
S1 = M + ":claude-code:sess-0001"

# The only columns that may hold free text, each capped by a CHECK on its length (design, "Patient data").
SHORT_TEXT = {
    ("session_episodes", "title"), ("session_summaries", "lines"), ("session_state_notes", "note"),
    ("step_results", "note"), ("asks", "question"), ("asks", "choices"), ("asks", "suggested_answer"),
    ("decisions", "answer"), ("category_stages", "reason"), ("branch_marks", "note"),
    ("session_homes", "evidence"), ("machines", "label"),
}
# Names a column holding transcript text, message text or file contents would have.
FORBIDDEN_COLUMN = re.compile(r"(transcript_text|message|content|body|prompt|excerpt|quote|diff|stdout|stderr)")


def ledger() -> sqlite3.Connection:
    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA foreign_keys = ON")
    db.execute("PRAGMA recursive_triggers = ON")  # so INSERT OR REPLACE fires the delete trigger
    db.executescript(SCHEMA.read_text(encoding="utf-8"))
    return db


def seed(db: sqlite3.Connection) -> None:
    """One made-up session on a ticket branch, with one graph run of two steps."""
    db.execute("INSERT INTO machines (machine_id, label, created_at, recorded_by) VALUES (?, 'test machine', ?, 'test')", (M, T))
    db.execute("""INSERT INTO sessions (session_uid, machine_id, tool, tool_session_id, started_at, started_by,
                  start_folder, transcript_path, recorded_at, recorded_by)
                  VALUES (?, ?, 'claude-code', 'sess-0001', ?, 'josh', '/tmp/made-up/josh_360', '/tmp/made-up/t.jsonl', ?, 'test')""",
               (S1, M, T, T))
    db.execute("""INSERT INTO session_episodes (session_uid, episode, began_at, last_activity_at, quiet_at, end_reason,
                  folder, repo, branch, title, title_source, recorded_at, recorded_by)
                  VALUES (?, 1, ?, ?, ?, 'quiet', '/tmp/made-up/josh_360', 'o/josh-360', 'JP-900/sample', 'Sample', 'ai', ?, 'test')""",
               (S1, T, T, T, T))
    db.execute("""INSERT INTO graph_runs (run_id, machine_id, graph_id, graph_source, graph_version, repo_commit,
                  subject_kind, subject_ref, tracker, ticket_key, phi, runner, started_at, recorded_by)
                  VALUES ('run-1', ?, 'triage', 'graph-file', 'abc1234', 'def5678', 'ticket', 'JP-900', 'jira', 'JP-900',
                  0, 'cli', ?, 'test')""", (M, T))
    db.execute("""INSERT INTO step_runs (run_id, step_id, step_kind, attempt, loop_count, tier, role, session_uid, started_at, recorded_by)
                  VALUES ('run-1', 'sign_off', 'role', 1, 0, 'mid', 'sign-off', ?, ?, 'test')""", (S1, T))
    db.execute("""INSERT INTO step_results (step_run_id, outcome, model, ended_at, recorded_by)
                  VALUES (1, 'ready', 'claude-sonnet-5-5', ?, 'test')""", (T,))
    db.execute("""INSERT INTO step_runs (run_id, step_id, step_kind, attempt, loop_count, started_at, recorded_by)
                  VALUES ('run-1', 'mark_ready', 'gate', 1, 0, ?, 'test')""", (T,))


class LedgerTest(unittest.TestCase):
    def ledger(self) -> sqlite3.Connection:
        db = ledger()
        self.addCleanup(db.close)
        return db


class SchemaLoads(LedgerTest):
    def test_loads_into_an_empty_database(self):
        db = self.ledger()
        self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 1)
        self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_codes_file_is_json_with_the_three_lists(self):
        codes = json.loads(CODES.read_text(encoding="utf-8"))
        for key in ("session_facts", "debrief_ended_how", "debrief_kinds"):
            self.assertTrue(codes[key], key)
        self.assertEqual(len(codes["debrief_kinds"]), 9)


class AppendOnly(LedgerTest):
    def test_every_table_refuses_update_and_delete(self):
        db = self.ledger()
        tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")]
        triggers = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type = 'trigger'")}
        for t in tables:
            self.assertIn(f"{t}_no_update", triggers, t)
            self.assertIn(f"{t}_no_delete", triggers, t)

    def test_an_update_and_a_delete_are_refused(self):
        db = self.ledger()
        seed(db)
        with self.assertRaisesRegex(sqlite3.DatabaseError, "append-only"):
            db.execute("UPDATE session_episodes SET title = 'changed'")
        with self.assertRaisesRegex(sqlite3.DatabaseError, "append-only"):
            db.execute("DELETE FROM sessions")

    def test_insert_or_replace_cannot_remove_a_row(self):
        db = self.ledger()
        seed(db)
        with self.assertRaisesRegex(sqlite3.DatabaseError, "append-only"):
            db.execute("""INSERT OR REPLACE INTO session_episodes (session_uid, episode, began_at, last_activity_at,
                          quiet_at, end_reason, recorded_at, recorded_by) VALUES (?, 1, ?, ?, ?, 'quiet', ?, 'test')""",
                       (S1, T, T, T, T))

    def test_a_resumed_session_adds_rows_and_keeps_the_old_ones(self):
        db = self.ledger()
        seed(db)
        db.execute("""INSERT INTO session_episodes (session_uid, episode, began_at, last_activity_at, quiet_at, end_reason,
                      recorded_at, recorded_by) VALUES (?, 2, ?, ?, ?, 'quiet', ?, 'test')""", (S1, T, T, T, T))
        rows = db.execute("SELECT episode, title FROM session_episodes ORDER BY episode").fetchall()
        self.assertEqual(rows, [(1, "Sample"), (2, None)])

    def test_a_correction_retracts_a_home_without_editing_it(self):
        db = self.ledger()
        seed(db)
        home = """INSERT INTO session_homes (session_uid, episode, method, tracker, ticket_key, priority, evidence,
                  conventions_version, jira_read, derived_at, recorded_by) VALUES (?, 1, ?, ?, ?, ?, ?, 'c1', ?, ?, 'test')"""
        db.execute(home, (S1, "branch", "jira", "JP-900", "devex", "JP-900/sample", "ok", "2026-11-16T10:00:00Z"))
        db.execute(home, (S1, "unassigned", None, None, "unassigned", "/tmp/made-up", "not-needed", "2026-11-16T11:00:00Z"))
        self.assertEqual(db.execute("SELECT method FROM current_homes").fetchall(), [("unassigned",)])
        db.execute("""INSERT INTO corrections (table_name, row_id, reason, corrected_at, corrected_by, recorded_by)
                      VALUES ('session_homes', 2, 'wrong', ?, 'josh', 'test')""", (T,))
        self.assertEqual(db.execute("SELECT method, ticket_key FROM current_homes").fetchall(), [("branch", "JP-900")])
        self.assertEqual(db.execute("SELECT COUNT(*) FROM session_homes").fetchone()[0], 2)


class PatientDataHasNoHome(LedgerTest):
    def columns(self, db):
        for (table,) in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'"):
            for _cid, name, ctype, *_rest in db.execute(f"PRAGMA table_info({table})"):
                yield table, name, ctype

    def test_no_column_is_named_for_transcript_message_or_file_text(self):
        for table, name, _ in self.columns(self.ledger()):
            self.assertIsNone(FORBIDDEN_COLUMN.search(name), f"{table}.{name}")

    def test_every_free_text_column_is_capped(self):
        db = self.ledger()
        sql = {r[0]: r[1] for r in db.execute("SELECT name, sql FROM sqlite_master WHERE type = 'table'")}
        for table, column in SHORT_TEXT:
            self.assertRegex(sql[table], rf"length\({column}\)", f"{table}.{column} has no length cap")

    def test_a_summary_is_at_most_five_lines(self):
        db = self.ledger()
        seed(db)
        add = """INSERT INTO session_summaries (session_uid, episode, method, lines, written_at, recorded_by)
                 VALUES (?, 1, 'copied', ?, ?, 'test')"""
        with self.assertRaises(sqlite3.IntegrityError):
            db.execute(add, (S1, "\n".join(f"line {n}" for n in range(6)), T))
        db.execute(add, (S1, "\n".join(f"line {n}" for n in range(5)), T))


class LooseEndsAreNotStored(LedgerTest):
    def test_no_table_or_view_of_loose_ends(self):
        names = [r[0] for r in self.ledger().execute("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")]
        self.assertFalse([n for n in names if "loose" in n], names)


class Runs(LedgerTest):
    def test_step_ledger_has_the_conventions_fields(self):
        db = self.ledger()
        seed(db)
        cur = db.execute("SELECT * FROM step_ledger ORDER BY step")
        fields = {d[0] for d in cur.description}
        for f in ("run", "step", "outcome", "loop_count", "session", "tier", "ticket", "started_at", "ended_at",
                  "graph_version", "model"):
            self.assertIn(f, fields)
        rows = {r[1]: r for r in cur.fetchall()}
        self.assertEqual(rows["sign_off"][2], "ready")
        self.assertIsNone(rows["mark_ready"][2])  # started, not ended yet

    def test_exit_refused_always_needs_josh(self):
        db = self.ledger()
        seed(db)
        with self.assertRaises(sqlite3.IntegrityError):
            db.execute("INSERT INTO run_ends (run_id, end_name, score, ended_at, recorded_by) VALUES ('run-1', 'exit_refused', 'neutral', ?, 'test')", (T,))

    def test_a_role_step_names_its_tier(self):
        db = self.ledger()
        seed(db)
        with self.assertRaises(sqlite3.IntegrityError):
            db.execute("""INSERT INTO step_runs (run_id, step_id, step_kind, attempt, loop_count, started_at, recorded_by)
                          VALUES ('run-1', 'sign_off', 'role', 2, 1, ?, 'test')""", (T,))


class Decisions(LedgerTest):
    def add(self, db, answer, how="answered", by="josh", quotes=None, supersedes=None):
        db.execute("""INSERT INTO decisions (category, question_key, system, work_type, answer, how, decided_by,
                      rests_on_decision_id, supersedes_decision_id, decided_at, recorded_by)
                      VALUES ('triage/ask_josh', 'triage/ask_josh', 'josh-360', 'code', ?, ?, ?, ?, ?, ?, 'test')""",
                   (answer, how, by, quotes, supersedes, T))

    def test_an_answer_from_memory_must_quote_a_decision(self):
        db = self.ledger()
        with self.assertRaises(sqlite3.IntegrityError):
            self.add(db, "yes", how="from-memory", by="memory")
        self.add(db, "yes")
        self.add(db, "yes", how="from-memory", by="memory", quotes=1)

    def test_superseded_and_overruled_decisions_are_never_returned(self):
        db = self.ledger()
        self.add(db, "first")
        self.add(db, "second", supersedes=1)
        self.add(db, "third")
        db.execute("""INSERT INTO decision_events (decision_id, kind, at, event_by, recorded_by)
                      VALUES (3, 'overruled', ?, 'josh', 'test')""", (T,))
        self.assertEqual([r[0] for r in db.execute("SELECT answer FROM current_decisions")], ["second"])

    def retract(self, db, table, row_id):
        db.execute("""INSERT INTO corrections (table_name, row_id, reason, corrected_at, corrected_by, recorded_by)
                      VALUES (?, ?, 'wrong', ?, 'josh', 'test')""", (table, row_id, T))

    def test_retracting_a_replacement_brings_the_original_back(self):
        db = self.ledger()
        self.add(db, "old")
        self.add(db, "new", supersedes=1)
        self.retract(db, "decisions", 2)
        self.assertEqual([r[0] for r in db.execute("SELECT answer FROM current_decisions")], ["old"])

    def test_retracting_an_overrule_brings_the_decision_back(self):
        db = self.ledger()
        self.add(db, "kept")
        db.execute("""INSERT INTO decision_events (decision_id, kind, at, event_by, recorded_by)
                      VALUES (1, 'overruled', ?, 'josh', 'test')""", (T,))
        self.retract(db, "decision_events", 1)
        self.assertEqual([r[0] for r in db.execute("SELECT answer FROM current_decisions")], ["kept"])


class RetractedRowsNeverCount(LedgerTest):
    """A correction withdraws a row from every view, not just the view of its own table (audit of PR #18)."""

    def retract(self, db, table, row_id):
        db.execute("""INSERT INTO corrections (table_name, row_id, reason, corrected_at, corrected_by, recorded_by)
                      VALUES (?, ?, 'wrong', ?, 'josh', 'test')""", (table, row_id, T))

    def test_retracted_step_rows_leave_the_step_ledger(self):
        db = self.ledger()
        seed(db)
        self.retract(db, "step_results", 1)
        self.assertIsNone(db.execute("SELECT outcome FROM step_ledger WHERE step = 'sign_off'").fetchone()[0])
        self.retract(db, "step_runs", 2)
        self.assertEqual([r[0] for r in db.execute("SELECT step FROM step_ledger")], ["sign_off"])

    def test_retracting_an_answer_reopens_its_ask(self):
        db = self.ledger()
        seed(db)
        db.execute("""INSERT INTO asks (ask_id, session_uid, category, question_key, system, work_type, question, stage,
                      channel, asked_at, recorded_by) VALUES ('ask-1', ?, 'triage/ask_josh', 'triage/ask_josh', 'josh-360',
                      'code', 'Which one?', 1, 'needs-you', ?, 'test')""", (S1, T))
        db.execute("""INSERT INTO decisions (ask_id, category, question_key, system, work_type, answer, how, decided_by,
                      decided_at, recorded_by) VALUES ('ask-1', 'triage/ask_josh', 'triage/ask_josh', 'josh-360', 'code',
                      'this one', 'answered', 'josh', ?, 'test')""", (T,))
        self.assertEqual(db.execute("SELECT COUNT(*) FROM open_asks").fetchone()[0], 0)
        self.retract(db, "decisions", 1)
        self.assertEqual([r[0] for r in db.execute("SELECT ask_id FROM open_asks")], ["ask-1"])

    def test_retracting_a_stage_change_falls_back_to_the_earlier_stage(self):
        db = self.ledger()
        add = """INSERT INTO category_stages (category, stage, set_by, reason, set_at, recorded_by)
                 VALUES ('triage/ask_josh', ?, 'josh', 'test', ?, 'test')"""
        db.execute(add, (1, "2026-11-16T10:00:00Z"))
        db.execute(add, (2, "2026-11-16T11:00:00Z"))
        self.retract(db, "category_stages", 2)
        self.assertEqual(db.execute("SELECT stage FROM current_category_stages").fetchall(), [(1,)])

    def test_retracting_a_branch_mark_falls_back_to_the_earlier_mark(self):
        db = self.ledger()
        add = """INSERT INTO branch_marks (git_root, branch, mark, marked_by, marked_at, recorded_by)
                 VALUES ('/tmp/made-up/repo', 'JP-900/sample', ?, 'josh', ?, 'test')"""
        db.execute(add, ("kept", "2026-11-16T10:00:00Z"))
        db.execute(add, ("not-kept", "2026-11-16T11:00:00Z"))
        self.assertEqual(db.execute("SELECT COUNT(*) FROM kept_branches").fetchone()[0], 0)
        self.retract(db, "branch_marks", 2)
        self.assertEqual([r[0] for r in db.execute("SELECT branch FROM kept_branches")], ["JP-900/sample"])


if __name__ == "__main__":
    unittest.main()
