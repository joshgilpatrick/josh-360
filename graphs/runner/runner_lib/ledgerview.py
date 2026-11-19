"""Read-only questions the runner asks the ledger (JP-117). It never writes: only the walker does."""
from __future__ import annotations

import sqlite3
from typing import List, Optional

OPEN = "NOT EXISTS (SELECT 1 FROM run_ends e WHERE e.run_id = g.run_id)"


def open_runs(conn: sqlite3.Connection, runner: str) -> List[dict]:
    """Runs of this runner with no end, oldest first."""
    cur = conn.execute("SELECT g.run_id, g.graph_id, g.ticket_key, g.started_at FROM graph_runs g WHERE g.runner = ? AND "
                       + OPEN + " ORDER BY g.started_at, g.id", (runner,))
    return [{"run": r[0], "graph": r[1], "ticket": r[2], "started_at": r[3]} for r in cur.fetchall()]


def ticket_has_open_run(conn: sqlite3.Connection, ticket: str) -> bool:
    row = conn.execute("SELECT 1 FROM graph_runs g WHERE g.ticket_key = ? AND " + OPEN + " LIMIT 1", (ticket,)).fetchone()
    return row is not None


def last_ended_run(conn: sqlite3.Connection, ticket: str, graph: str) -> Optional[str]:
    row = conn.execute(
        "SELECT g.run_id FROM graph_runs g JOIN run_ends e ON e.run_id = g.run_id WHERE g.ticket_key = ? AND "
        "g.graph_id = ? ORDER BY e.ended_at DESC, e.id DESC LIMIT 1", (ticket, graph)).fetchone()
    return row[0] if row else None


def open_step(conn: sqlite3.Connection, run: str) -> Optional[dict]:
    """The newest step row that has no result, else None."""
    row = conn.execute(
        "SELECT s.step_id, s.step_kind, s.attempt, s.started_at FROM step_runs s WHERE s.run_id = ? AND NOT EXISTS "
        "(SELECT 1 FROM step_results r WHERE r.step_run_id = s.id) ORDER BY s.id DESC LIMIT 1", (run,)).fetchone()
    return {"step": row[0], "kind": row[1], "attempt": row[2], "started_at": row[3]} if row else None


def run_rows(conn: sqlite3.Connection, run: str) -> List[dict]:
    """Every step row of a run, oldest first, with the tool's own session id when a result named one."""
    cur = conn.execute(
        "SELECT s.step_id, s.step_kind, s.attempt, s.loop_count, s.tier, r.outcome, r.model, x.tool_session_id, "
        "s.started_at, r.ended_at FROM step_runs s LEFT JOIN step_results r ON r.step_run_id = s.id AND r.version = "
        "(SELECT MAX(version) FROM step_results WHERE step_run_id = s.id) "
        "LEFT JOIN sessions x ON x.session_uid = r.session_uid WHERE s.run_id = ? ORDER BY s.id", (run,))
    keys = ("step", "kind", "attempt", "loop_count", "tier", "outcome", "model", "session", "started_at", "ended_at")
    return [dict(zip(keys, row)) for row in cur.fetchall()]


def ended_runs(conn: sqlite3.Connection, since: str, runner: Optional[str] = None) -> List[dict]:
    """Runs that ended at or after `since` (an ISO time), newest first; only this runner's when `runner` is given."""
    sql = ("SELECT g.run_id, g.graph_id, g.ticket_key, e.end_name, e.score, e.ended_at, g.started_at FROM graph_runs g "
           "JOIN current_run_ends e ON e.run_id = g.run_id WHERE e.ended_at >= ?")
    args = [since]
    if runner is not None:
        sql += " AND g.runner = ?"
        args.append(runner)
    cur = conn.execute(sql + " ORDER BY e.ended_at DESC, e.id DESC", args)
    return [{"run": r[0], "graph": r[1], "ticket": r[2], "end": r[3], "score": r[4], "ended_at": r[5], "started_at": r[6]}
            for r in cur.fetchall()]


def run_costs(conn: sqlite3.Connection, run: str) -> dict:
    """Each step attempt's cost with its subagents, keyed by (step, attempt, loop count) (JP-170). Only a step that had a
    session is here; a gate or an ask step costs nothing and is absent."""
    cur = conn.execute(
        "SELECT step, attempt, loop_count, own_cost_usd, subagent_cost_usd, cost_usd, own_pricing_status, subagents, "
        "subagents_not_fully_priced, subagents_unpriced FROM step_costs_rolled_up WHERE run = ? AND session_uid IS NOT NULL",
        (run,))
    return {(r[0], r[1], r[2]): r[3:] for r in cur.fetchall()}


def ticket_runs(conn: sqlite3.Connection, ticket: str) -> List[dict]:
    """Every run on a ticket, any runner, newest first, with its end when it has one (JP-172)."""
    cur = conn.execute(
        "SELECT g.run_id, g.graph_id, g.ticket_key, g.runner, g.started_at, e.end_name, e.score, e.ended_at "
        "FROM graph_runs g LEFT JOIN current_run_ends e ON e.run_id = g.run_id WHERE g.ticket_key = ? "
        "ORDER BY g.started_at DESC, g.id DESC", (ticket,))
    keys = ("run", "graph", "ticket", "runner", "started_at", "end", "score", "ended_at")
    return [dict(zip(keys, r)) for r in cur.fetchall()]
