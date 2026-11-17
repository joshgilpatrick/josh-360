"""Everything the walker reads from and writes to the ledger. Standard library only.

Rows are only ever added (the ledger refuses updates and deletes). A step is two rows: `step_runs` when it starts and
`step_results` when it ends. A run is `graph_runs`, and its end is `run_ends`. Questions are `asks` and answers are
`decisions`. See ledger/schema.sql and docs/design/data-model.md.
"""
from __future__ import annotations

import datetime
import json
import sqlite3
from typing import Dict, List, Optional

from ledger import db, sessions
from laptop import common

BY = "graphs/tools/walker.py"
PRECEDENT_SQL = """SELECT id, answer, decided_at, ticket_key FROM current_decisions
WHERE category = :category AND system IS :system AND work_type IS :work_type
ORDER BY decided_at DESC, id DESC LIMIT 3"""
RUNS_PER_DAY = 5


def runs_in_last_day(conn: sqlite3.Connection, ticket_key: str, now: str) -> int:
    since = (datetime.datetime.strptime(now, "%Y-%m-%dT%H:%M:%SZ") - datetime.timedelta(days=1)).strftime(
        "%Y-%m-%dT%H:%M:%SZ")
    return conn.execute("SELECT COUNT(*) FROM graph_runs WHERE ticket_key = ? AND started_at >= ?",
                        (ticket_key, since)).fetchone()[0]


def previous_run(conn: sqlite3.Connection, ticket_key: str) -> Optional[str]:
    row = conn.execute("SELECT run_id FROM graph_runs WHERE ticket_key = ? ORDER BY started_at DESC, id DESC LIMIT 1",
                       (ticket_key,)).fetchone()
    return row[0] if row else None


def create_run(conn, *, run_id, graph_id, graph_version, repo_commit, subject_kind, subject_ref, ticket_key, phi,
               runner, now) -> None:
    tracker = "jira" if ticket_key else None
    previous = previous_run(conn, ticket_key) if ticket_key else None
    conn.execute(
        "INSERT INTO graph_runs (run_id, machine_id, graph_id, graph_source, graph_version, repo_commit, "
        "subject_kind, subject_ref, tracker, ticket_key, previous_run_id, phi, runner, started_at, recorded_by) "
        "VALUES (?, ?, ?, 'graph-file', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (run_id, db.machine_id(conn), graph_id, graph_version, repo_commit, subject_kind, subject_ref, tracker,
         ticket_key, previous, 1 if phi else 0, runner, now, BY))
    if ticket_key:
        conn.execute("INSERT INTO ticket_links (run_id, tracker, ticket_key, relation, source, linked_at, recorded_by) "
                     "VALUES (?, 'jira', ?, 'subject', 'walker', ?, ?)", (run_id, ticket_key, now, BY))


def run_row(conn, run_id: str) -> Optional[sqlite3.Row]:
    conn.row_factory = sqlite3.Row
    try:
        return conn.execute("SELECT * FROM graph_runs WHERE run_id = ?", (run_id,)).fetchone()
    finally:
        conn.row_factory = None


def start_step(conn, run_id, step, kind, attempt, loop_count, tier, role, agent, allowed, now) -> int:
    cur = conn.execute(
        "INSERT INTO step_runs (run_id, step_id, step_kind, attempt, loop_count, tier, role, agent, allowed_by_josh, "
        "started_at, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (run_id, step, kind, attempt, loop_count, tier, role, agent, 1 if allowed else 0, now, BY))
    return cur.lastrowid


def end_step(conn, step_run_id, outcome, now, model=None, session_uid=None, note=None) -> None:
    conn.execute("INSERT INTO step_results (step_run_id, outcome, model, session_uid, note, ended_at, recorded_by) "
                 "VALUES (?, ?, ?, ?, ?, ?, ?)", (step_run_id, outcome, model or None, session_uid, note, now, BY))


def end_run(conn, run_id, end_name, score, now) -> None:
    conn.execute("INSERT INTO run_ends (run_id, end_name, score, ended_at, recorded_by) VALUES (?, ?, ?, ?, ?)",
                 (run_id, end_name, score, now, BY))


def rows_for(conn, run_id: str) -> List[dict]:
    """The run's step rows, oldest first, as the engine replays them. A row with no result has outcome None."""
    cur = conn.execute(
        "SELECT s.id, s.step_id, s.attempt, s.allowed_by_josh, s.step_kind, r.outcome, r.session_uid, r.model "
        "FROM step_runs s LEFT JOIN step_results r ON r.step_run_id = s.id AND r.version = "
        "(SELECT MAX(version) FROM step_results WHERE step_run_id = s.id) WHERE s.run_id = ? ORDER BY s.id", (run_id,))
    return [{"id": r[0], "step": r[1], "attempt": r[2], "allowed": bool(r[3]), "kind": r[4], "outcome": r[5],
             "session_uid": r[6], "model": r[7]} for r in cur.fetchall()]


def run_end(conn, run_id: str) -> Optional[Dict[str, str]]:
    row = conn.execute("SELECT end_name, score FROM current_run_ends WHERE run_id = ?", (run_id,)).fetchone()
    return {"end": row[0], "score": row[1]} if row else None


def ensure_session(conn, tool: str, tool_session_id: str, now: str) -> str:
    return sessions.ensure(conn, tool=tool, tool_session_id=tool_session_id, started_at=now, started_by="walker",
                           now=now, by=BY)


def category_stage(conn, category: str) -> int:
    row = conn.execute("SELECT stage FROM current_category_stages WHERE category = ?", (category,)).fetchone()
    return row[0] if row else 1


def lookup_precedent(conn, step_run_id, run_id, category, question_key, system, work_type, now) -> List[dict]:
    cur = conn.execute(PRECEDENT_SQL, {"category": category, "system": system, "work_type": work_type})
    rows = [{"id": r[0], "answer": r[1], "decided_at": r[2], "ticket_key": r[3]} for r in cur.fetchall()]
    conn.execute("INSERT INTO memory_lookups (run_id, step_run_id, category, question_key, system, work_type, found, "
                 "looked_up_at, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                 (run_id, step_run_id, category, question_key, system, work_type, len(rows), now, BY))
    return rows


def record_ask(conn, *, ask_id, run_id, step_run_id, category, question_key, system, work_type, ticket_key,
               question, choices, stage, suggested, precedent_id, channel, now) -> None:
    conn.execute(
        "INSERT INTO asks (ask_id, run_id, step_run_id, category, question_key, system, work_type, tracker, "
        "ticket_key, question, choices, stage, suggested_answer, precedent_decision_id, channel, asked_at, "
        "recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (ask_id, run_id, step_run_id, category, question_key, system, work_type, "jira" if ticket_key else None,
         ticket_key, question, json.dumps(choices) if choices is not None else None, stage, suggested, precedent_id,
         channel, now, BY))


def ask_for_step(conn, step_run_id: int) -> Optional[sqlite3.Row]:
    conn.row_factory = sqlite3.Row
    try:
        return conn.execute("SELECT * FROM asks WHERE step_run_id = ?", (step_run_id,)).fetchone()
    finally:
        conn.row_factory = None


def record_decision(conn, ask, answer: str, how: str, rests_on: Optional[int], now: str) -> None:
    conn.execute(
        "INSERT INTO decisions (ask_id, category, question_key, system, work_type, tracker, ticket_key, answer, how, "
        "decided_by, rests_on_decision_id, decided_at, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'josh', ?, ?, ?)",
        (ask["ask_id"], ask["category"], ask["question_key"], ask["system"], ask["work_type"], ask["tracker"],
         ask["ticket_key"], answer[:500], how, rests_on, now, BY))


def add_run_file(conn, run_id, step_run_id, kind, name, path, sha, now) -> None:
    conn.execute("INSERT INTO run_files (run_id, step_run_id, kind, name, path, sha256, saved_at, recorded_by) "
                 "VALUES (?, ?, ?, ?, ?, ?, ?, ?)", (run_id, step_run_id, kind, name, path, sha, now, BY))


def connect():
    return db.connect_existing(db.ledger_path())


def now() -> str:
    return common.now_utc()
