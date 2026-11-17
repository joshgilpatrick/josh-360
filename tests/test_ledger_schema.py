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
                  conventions_version, jira_read, patient_data, derived_at, recorded_by)
                  VALUES (?, 1, ?, ?, ?, ?, ?, 'c1', ?, 1, ?, 'test')"""
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


# ---------------------------------------------------------------------------------------------------------------
# JP-148: the JP-146 review's fixes A1 to A5. Each class is named after the scenario on JP-148 it proves.
# ---------------------------------------------------------------------------------------------------------------

S2 = M + ":claude-code:sess-0002"

# The precedent query `ledger/ask.py precedent` runs (design, "Queries agents may call"; plan, Task 7). Its test in
# JP-107 reuses this text, so the two cannot drift.
PRECEDENT_SQL = """SELECT id, answer, decided_at, ticket_key FROM current_decisions
WHERE category = :category AND system IS :system AND work_type IS :work_type
ORDER BY decided_at DESC, id DESC LIMIT 3"""


def started(db: sqlite3.Connection, uid: str = S2) -> None:
    """A session that has started and not gone quiet: a sessions row and no episode."""
    db.execute("INSERT OR IGNORE INTO machines (machine_id, label, created_at, recorded_by) VALUES (?, 'test machine', ?, 'test')", (M, T))
    db.execute("""INSERT INTO sessions (session_uid, machine_id, tool, tool_session_id, started_at, started_by,
                  recorded_at, recorded_by) VALUES (?, ?, 'claude-code', ?, ?, 'walker', ?, 'test')""",
               (uid, M, uid.rsplit(":", 1)[1], T, T))


def withdraw(db: sqlite3.Connection, table: str, row_id: int) -> int:
    cur = db.execute("""INSERT INTO corrections (table_name, row_id, reason, corrected_at, corrected_by, recorded_by)
                        VALUES (?, ?, 'wrong', ?, 'josh', 'test')""", (table, row_id, T))
    return cur.lastrowid


class AGraphStepCanBeTiedToARunningSession(LedgerTest):
    """JP-148 scenario (A1): the sessions row is written at session start, so rows written while it runs can name it."""

    def test_a_step_run_for_a_started_session_is_accepted(self):
        db = self.ledger()
        seed(db)
        started(db)
        self.assertEqual(db.execute("SELECT COUNT(*) FROM session_episodes WHERE session_uid = ?", (S2,)).fetchone()[0], 0)
        db.execute("""INSERT INTO step_runs (run_id, step_id, step_kind, attempt, loop_count, tier, role, session_uid,
                      started_at, recorded_by) VALUES ('run-1', 'review', 'role', 1, 0, 'mid', 'reviewer', ?, ?, 'test')""", (S2, T))
        step = db.execute("SELECT id FROM step_runs WHERE session_uid = ?", (S2,)).fetchone()[0]
        db.execute("""INSERT INTO step_results (step_run_id, outcome, model, session_uid, ended_at, recorded_by)
                      VALUES (?, 'clean', 'claude-sonnet-5-5', ?, ?, 'test')""", (step, S2, T))
        db.execute("""INSERT INTO asks (ask_id, session_uid, category, question_key, stage, channel, asked_at, recorded_by)
                      VALUES ('ask-2', ?, 'triage/ask_josh', 'triage/ask_josh', 1, 'needs-you', ?, 'test')""", (S2, T))
        db.execute("""INSERT INTO ticket_links (session_uid, tracker, ticket_key, relation, source, linked_at, recorded_by)
                      VALUES (?, 'jira', 'JP-900', 'touched', 'walker', ?, 'test')""", (S2, T))
        db.execute("""INSERT INTO comment_deliveries (tracker, ticket_key, comment_id, author_account, session_uid, via,
                      delivered_at, recorded_by) VALUES ('jira', 'JP-900', '10001', 'acct-1', ?, 'binding', ?, 'test')""", (S2, T))
        db.execute("""INSERT INTO model_calls (purpose, subject_session_uid, model, called_at, recorded_by)
                      VALUES ('other', ?, 'claude-haiku-5-5', ?, 'test')""", (S2, T))
        self.assertEqual(db.execute("SELECT session FROM step_ledger WHERE step = 'review'").fetchone()[0], S2)

    def test_a_step_run_for_a_session_with_no_row_is_refused(self):
        """Why the row must come first: the walker's `ledger.sessions.ensure` adds it when it is missing."""
        db = self.ledger()
        seed(db)
        with self.assertRaisesRegex(sqlite3.IntegrityError, "FOREIGN KEY"):
            db.execute("""INSERT INTO step_runs (run_id, step_id, step_kind, attempt, loop_count, tier, role, session_uid,
                          started_at, recorded_by) VALUES ('run-1', 'review', 'role', 1, 0, 'mid', 'reviewer', ?, ?, 'test')""",
                       (S2, T))


class AWithdrawnRowCanBeReplaced(LedgerTest):
    """JP-148 scenario (A3): a withdrawn row in a one-per-key table is replaced by the next version."""

    def summary(self, db, lines, version=1):
        return db.execute("""INSERT INTO session_summaries (session_uid, episode, method, lines, version, written_at, recorded_by)
                             VALUES (?, 1, 'copied', ?, ?, ?, 'test')""", (S1, lines, version, T)).lastrowid

    def test_a_withdrawn_summary_is_replaced_and_the_view_shows_the_replacement(self):
        db = self.ledger()
        seed(db)
        first = self.summary(db, "wrong line")
        withdraw(db, "session_summaries", first)
        self.summary(db, "right line", version=2)
        self.assertEqual(db.execute("SELECT lines, version FROM current_session_summaries").fetchall(), [("right line", 2)])

    def test_a_replacement_needs_the_earlier_version_withdrawn(self):
        db = self.ledger()
        seed(db)
        self.summary(db, "first")
        with self.assertRaisesRegex(sqlite3.DatabaseError, "version before it withdrawn"):
            self.summary(db, "second", version=2)
        with self.assertRaises(sqlite3.IntegrityError):  # the same version twice is still refused
            self.summary(db, "again")

    def test_every_one_per_key_table_takes_a_replacement(self):
        db = self.ledger()
        seed(db)
        db.execute("INSERT INTO model_calls (purpose, model, called_at, recorded_by) VALUES ('debrief', 'claude-haiku-5-5', ?, 'test')", (T,))
        db.execute("INSERT INTO run_ends (run_id, end_name, score, ended_at, recorded_by) VALUES ('run-1', 'finished', 'success', ?, 'test')", (T,))
        db.execute("""INSERT INTO debriefs (session_uid, episode, model_call_id, form_version, ended_how, written_at, recorded_by)
                      VALUES (?, 1, 1, 'f1', 'delivered', ?, 'test')""", (S1, T))
        replacements = {
            "session_episodes": ("""INSERT INTO session_episodes (session_uid, episode, began_at, last_activity_at, quiet_at,
                                    end_reason, title, version, recorded_at, recorded_by)
                                    VALUES (?, 1, ?, ?, ?, 'quiet', 'Fixed', 2, ?, 'test')""", (S1, T, T, T, T),
                                 "SELECT title FROM current_session_episodes", "Fixed"),
            "debriefs": ("""INSERT INTO debriefs (session_uid, episode, model_call_id, form_version, ended_how, version,
                            written_at, recorded_by) VALUES (?, 1, 1, 'f1', 'blocked', 2, ?, 'test')""", (S1, T),
                         "SELECT ended_how FROM current_debriefs", "blocked"),
            "step_results": ("""INSERT INTO step_results (step_run_id, outcome, model, version, ended_at, recorded_by)
                                VALUES (1, 'not_ready', 'claude-sonnet-5-5', 2, ?, 'test')""", (T,),
                             "SELECT outcome FROM step_ledger WHERE step = 'sign_off'", "not_ready"),
            "run_ends": ("""INSERT INTO run_ends (run_id, end_name, score, version, ended_at, recorded_by)
                            VALUES ('run-1', 'exit_refused', 'needs-josh', 2, ?, 'test')""", (T,),
                         "SELECT end_name FROM current_run_ends", "exit_refused"),
        }
        for table, (sql, args, read, expected) in replacements.items():
            with self.subTest(table=table):
                with self.assertRaisesRegex(sqlite3.DatabaseError, "version before it withdrawn"):
                    db.execute(sql, args)
                withdraw(db, table, 1)
                db.execute(sql, args)
                self.assertEqual(db.execute(read).fetchall(), [(expected,)])

    def test_undoing_a_withdrawal_brings_the_row_back_and_it_can_be_withdrawn_again(self):
        db = self.ledger()
        seed(db)
        first = self.summary(db, "kept after all")
        c1 = withdraw(db, "session_summaries", first)
        self.assertEqual(db.execute("SELECT COUNT(*) FROM current_session_summaries").fetchone()[0], 0)
        with self.assertRaisesRegex(sqlite3.DatabaseError, "already withdrawn"):
            withdraw(db, "session_summaries", first)
        c2 = withdraw(db, "corrections", c1)
        self.assertEqual(db.execute("SELECT lines FROM current_session_summaries").fetchall(), [("kept after all",)])
        with self.assertRaisesRegex(sqlite3.DatabaseError, "cannot itself be withdrawn"):
            withdraw(db, "corrections", c2)
        withdraw(db, "session_summaries", first)
        self.assertEqual(db.execute("SELECT COUNT(*) FROM current_session_summaries").fetchone()[0], 0)

    def test_undoing_a_withdrawal_reaches_every_view(self):
        db = self.ledger()
        seed(db)
        c1 = withdraw(db, "step_results", 1)
        self.assertIsNone(db.execute("SELECT outcome FROM step_ledger WHERE step = 'sign_off'").fetchone()[0])
        withdraw(db, "corrections", c1)
        self.assertEqual(db.execute("SELECT outcome FROM step_ledger WHERE step = 'sign_off'").fetchone()[0], "ready")

    def test_rows_about_an_episode_need_the_episode(self):
        db = self.ledger()
        seed(db)
        with self.assertRaisesRegex(sqlite3.DatabaseError, "no such episode: session_summaries"):
            db.execute("""INSERT INTO session_summaries (session_uid, episode, method, lines, written_at, recorded_by)
                          VALUES (?, 2, 'copied', 'x', ?, 'test')""", (S1, T))
        triggers = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type = 'trigger'")}
        for table in ("session_refs", "session_homes", "session_summaries", "session_state_notes", "session_facts",
                      "session_usage", "debriefs"):
            self.assertIn(f"{table}_episode_exists", triggers)


class AgentManagerSessionsAreRecordedAsSuch(unittest.TestCase):
    """JP-148 scenario (A4): the starter comes from codes.json's ordered rules, which the SessionStart hook reads."""

    def started_by(self, environ: dict) -> str:
        """The rule as the spool hook applies it (plan, Task 3): the first matching rule wins."""
        rules = json.loads(CODES.read_text(encoding="utf-8"))["started_by_env"]
        for rule in rules["rules"]:
            value = environ.get(rule["env"])
            if value is not None and value != "" and rule.get("equals", value) == value:
                return rule["started_by"]
        return rules["default"]

    def test_agent_manager_without_a_ticket_key_is_agent_manager(self):
        self.assertEqual(self.started_by({"AGENT_MANAGER_SESSION_ID": "am-1"}), "agent-manager")

    def test_the_daemon_ticket_key_stays_daemon(self):
        self.assertEqual(self.started_by({"ACTION_TRIAGE_TICKET_KEY": "JP-900", "AGENT_MANAGER_SESSION_ID": "am-1"}), "daemon")

    def test_the_other_starters(self):
        self.assertEqual(self.started_by({"JOSH360_RUN_ID": "run-1", "AGENT_MANAGER_SESSION_ID": "am-1"}), "walker")
        self.assertEqual(self.started_by({"DESK_WORKER": "1", "AGENT_MANAGER_SESSION_ID": "am-1"}), "desk")
        self.assertEqual(self.started_by({"DESK_WORKER": "0", "AGENT_MANAGER_SESSION_ID": "am-1"}), "agent-manager")
        self.assertEqual(self.started_by({"ACTION_TRIAGE_ALLOW_ATLASSIAN_WRITES": "0"}), "daemon")
        self.assertEqual(self.started_by({}), "josh")

    def test_every_value_is_allowed_by_the_schema(self):
        rules = json.loads(CODES.read_text(encoding="utf-8"))["started_by_env"]
        allowed = re.search(r"started_by\s+TEXT NOT NULL CHECK \(started_by IN \(([^)]*)\)\)", SCHEMA.read_text(encoding="utf-8"))
        values = set(re.findall(r"'([a-z-]+)'", allowed.group(1)))
        for value in [r["started_by"] for r in rules["rules"]] + [rules["default"]]:
            self.assertIn(value, values)


class PrecedentStaysInsideItsCategory(LedgerTest):
    """JP-148 scenario (A5): an approval for a single ticket is never precedent for an epic with children."""

    SINGLE = "ticket-creation/approve;system=josh-360;type=task;shape=single;action=create"
    EPIC = "ticket-creation/approve;system=josh-360;type=epic;shape=epic_with_tickets;action=create"

    def decide(self, db, category, how="answered", by="josh", rests_on=None):
        return db.execute("""INSERT INTO decisions (category, question_key, system, work_type, answer, how, decided_by,
                             rests_on_decision_id, decided_at, recorded_by)
                             VALUES (?, 'ticket-creation/approve', 'josh-360', 'code', 'approve', ?, ?, ?, ?, 'test')""",
                          (category, how, by, rests_on, T)).lastrowid

    def precedent(self, db, category):
        return db.execute(PRECEDENT_SQL, {"category": category, "system": "josh-360", "work_type": "code"}).fetchall()

    def test_the_single_ticket_approval_is_not_returned_for_an_epic(self):
        db = self.ledger()
        single = self.decide(db, self.SINGLE)
        self.assertEqual(self.precedent(db, self.EPIC), [])
        self.assertEqual([r[0] for r in self.precedent(db, self.SINGLE)], [single])

    def test_no_row_can_use_a_precedent_from_another_category(self):
        db = self.ledger()
        seed(db)
        single = self.decide(db, self.SINGLE)
        with self.assertRaisesRegex(sqlite3.DatabaseError, "another category: decisions"):
            self.decide(db, self.EPIC, how="from-memory", by="memory", rests_on=single)
        with self.assertRaisesRegex(sqlite3.DatabaseError, "another category: asks"):
            db.execute("""INSERT INTO asks (ask_id, session_uid, category, question_key, stage, suggested_answer,
                          precedent_decision_id, channel, asked_at, recorded_by)
                          VALUES ('ask-9', ?, ?, 'ticket-creation/approve', 2, 'approve', ?, 'needs-you', ?, 'test')""",
                       (S1, self.EPIC, single, T))
        with self.assertRaisesRegex(sqlite3.DatabaseError, "another category: memory_lookups"):
            db.execute("""INSERT INTO memory_lookups (category, question_key, system, work_type, found, used_decision_id,
                          looked_up_at, recorded_by) VALUES (?, 'ticket-creation/approve', 'josh-360', 'code', 1, ?, ?, 'test')""",
                       (self.EPIC, single, T))
        self.decide(db, self.SINGLE, how="from-memory", by="memory", rests_on=single)  # same category is fine


class PatientDataRule(LedgerTest):
    """JP-148 (A2): the schema side of the stricter patient-data rule; the rest is the writers' (design, "Patient data")."""

    def test_a_withheld_title_holds_no_text(self):
        db = self.ledger()
        seed(db)
        add = """INSERT INTO session_episodes (session_uid, episode, began_at, last_activity_at, quiet_at, end_reason,
                 title, title_source, recorded_at, recorded_by) VALUES (?, 2, ?, ?, ?, 'quiet', ?, 'withheld', ?, 'test')"""
        with self.assertRaises(sqlite3.IntegrityError):
            db.execute(add, (S1, T, T, T, "Some words", T))
        db.execute(add, (S1, T, T, T, None, T))

    def test_a_home_with_no_known_system_counts_as_patient_data(self):
        db = self.ledger()
        seed(db)
        add = """INSERT INTO session_homes (session_uid, episode, method, priority, evidence, conventions_version,
                 jira_read, patient_data, derived_at, recorded_by) VALUES (?, 1, 'unassigned', 'unassigned', '/tmp/made-up',
                 'c1', 'not-needed', ?, ?, 'test')"""
        with self.assertRaises(sqlite3.IntegrityError):
            db.execute(add, (S1, 0, T))
        db.execute(add, (S1, 1, T))


if __name__ == "__main__":
    unittest.main()
