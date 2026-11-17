"""The one way a `sessions` row is written (JP-107, Task 5). Python 3.9, standard library only.

The row exists before anything else about the session (JP-148, review finding A1): the recorder writes it from the
SessionStart spool line, and the recorder, the backfill and the walker (JP-114) all call `ensure` when they meet a
session that has no row, so rows written while the session still runs (step runs, asks, ticket links) can point at it.
"""
from __future__ import annotations

import sqlite3
from typing import Optional

from ledger import db

TOOLS = ("claude-code", "opencode", "pi", "codex", "other")
STARTERS = ("josh", "daemon", "walker", "desk", "agent-manager", "background", "josh-360", "unknown")


def uid_for(conn: sqlite3.Connection, tool: str, tool_session_id: str) -> str:
    return "{}:{}:{}".format(db.machine_id(conn), tool, tool_session_id)


def ensure(conn: sqlite3.Connection, *, tool: str, tool_session_id: str, started_at: str, started_by: str, now: str,
           by: str, start_folder: Optional[str] = None, transcript_path: Optional[str] = None,
           entrypoint: Optional[str] = None) -> str:
    """Write the session's row if it has none, and return its session_uid.

    INSERT OR IGNORE, so a second call, or a call after another writer got there first, changes nothing: the first
    writer's started_by and started_at stand. A starter this code does not know is recorded as `unknown`.
    """
    if tool not in TOOLS:
        raise ValueError("unknown tool: {}".format(tool))
    if not tool_session_id:
        raise ValueError("a session needs its tool's session id")
    if started_by not in STARTERS:
        started_by = "unknown"
    if entrypoint is not None:
        entrypoint = entrypoint[:40]
    uid = uid_for(conn, tool, tool_session_id)
    conn.execute(
        "INSERT OR IGNORE INTO sessions (session_uid, machine_id, tool, tool_session_id, started_at, started_by, "
        "entrypoint, start_folder, transcript_path, recorded_at, recorded_by) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (uid, db.machine_id(conn), tool, tool_session_id, started_at, started_by, entrypoint, start_folder,
         transcript_path, now, by))
    return uid
