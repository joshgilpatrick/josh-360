#!/usr/bin/env python3
"""Withdraw a ledger row with a `corrections` row, and bring it back or replace it (JP-107, Task 2).

    python3 ledger/correct.py --table session_homes --row 2 --reason wrong [--by josh|script]
    python3 ledger/correct.py --undo <correction id> [--by josh|script]

A row is never edited or deleted (docs/design/data-model.md, "The append-only rule"). Withdrawing it writes one
correction; the `current_*` views then leave it out. Undoing a withdrawal is a correction of that correction, allowed
once. In the five one-per-key tables the replacement of a withdrawn row is its next version, written after the
correction, so `--replacement` is refused for them and `next_version` says which number to write.

Prints the new correction's id. Python 3.9, standard library only.
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path
from typing import Dict, List, Optional

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from ledger import _repo  # noqa: E402,F401
from ledger import db  # noqa: E402
from laptop import common  # noqa: E402

REASONS = ("wrong", "duplicate", "test-row", "patient-data")
BY = ("josh", "script")
RECORDED_BY = "ledger/correct.py"

# The tables that hold one row per natural key, and the columns of that key (the version is the last part).
VERSIONED: Dict[str, tuple] = {
    "session_episodes": ("session_uid", "episode"),
    "session_summaries": ("session_uid", "episode"),
    "debriefs": ("session_uid", "episode"),
    "step_results": ("step_run_id",),
    "run_ends": ("run_id",),
}


def _tables(conn: sqlite3.Connection) -> List[str]:
    return [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")]


def correct(conn: sqlite3.Connection, table: str, row_id: int, reason: str, by: str, now: str,
            replacement: Optional[int] = None) -> int:
    """Withdraw one row. Returns the correction's id. ValueError, with nothing written, for anything wrong."""
    if table not in _tables(conn) or table.startswith("sqlite_"):
        raise ValueError("no such table: {}".format(table))
    if reason not in REASONS:
        raise ValueError("reason must be one of {}".format(", ".join(REASONS)))
    if by not in BY:
        raise ValueError("by must be josh or script")
    if conn.execute("SELECT 1 FROM {} WHERE id = ?".format(table), (row_id,)).fetchone() is None:
        raise ValueError("no row {} in {}".format(row_id, table))
    if replacement is not None:
        if table in VERSIONED:
            raise ValueError("{} replaces a withdrawn row with its next version, not a replacement row".format(table))
        if conn.execute("SELECT 1 FROM {} WHERE id = ?".format(table), (replacement,)).fetchone() is None:
            raise ValueError("no replacement row {} in {}".format(replacement, table))
    try:
        cur = conn.execute(
            "INSERT INTO corrections (table_name, row_id, reason, replacement_row_id, corrected_at, corrected_by, "
            "recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?)", (table, row_id, reason, replacement, now, by, RECORDED_BY))
    except sqlite3.DatabaseError as e:
        raise ValueError(str(e)) from e
    return cur.lastrowid


def undo(conn: sqlite3.Connection, correction_id: int, by: str, now: str) -> int:
    """Bring a withdrawn row back: a correction of that correction. Allowed once; the undo cannot be undone."""
    return correct(conn, "corrections", correction_id, "wrong", by, now)


def next_version(conn: sqlite3.Connection, table: str, key: Dict[str, object]) -> int:
    """The version to write next for one key of a versioned table.

    1 when no row exists; one more than the newest when that row is withdrawn; ValueError while it is in force.
    """
    if table not in VERSIONED:
        raise ValueError("{} is not a versioned table".format(table))
    if set(key) != set(VERSIONED[table]):
        raise ValueError("{} is keyed by {}".format(table, ", ".join(VERSIONED[table])))
    where = " AND ".join("{} = ?".format(c) for c in VERSIONED[table])
    row = conn.execute("SELECT id, version FROM {} WHERE {} ORDER BY version DESC LIMIT 1".format(table, where),
                       tuple(key[c] for c in VERSIONED[table])).fetchone()
    if row is None:
        return 1
    in_force = conn.execute("SELECT 1 FROM live_corrections WHERE table_name = ? AND row_id = ?",
                            (table, row[0])).fetchone()
    if not in_force:
        raise ValueError("version {} of that {} row is still in force; withdraw it first".format(row[1], table))
    return row[1] + 1


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="correct.py", description=__doc__.split("\n")[0])
    parser.add_argument("--table")
    parser.add_argument("--row", type=int)
    parser.add_argument("--reason", choices=REASONS)
    parser.add_argument("--replacement", type=int)
    parser.add_argument("--undo", type=int, metavar="CORRECTION_ID")
    parser.add_argument("--by", choices=BY, default="josh")
    args = parser.parse_args(argv)
    if args.undo is None and not (args.table and args.row is not None and args.reason):
        parser.error("give --table, --row and --reason, or --undo <correction id>")
    if args.undo is not None and (args.table or args.row is not None or args.reason or args.replacement is not None):
        parser.error("--undo takes no other withdrawal arguments")
    try:
        conn = db.connect_existing(db.ledger_path())
    except FileNotFoundError as e:
        print("correct: {}".format(e), file=sys.stderr)
        return 2
    try:
        now = common.now_utc()
        if args.undo is not None:
            new_id = undo(conn, args.undo, args.by, now)
        else:
            new_id = correct(conn, args.table, args.row, args.reason, args.by, now, args.replacement)
    except ValueError as e:
        print("correct: {}".format(e), file=sys.stderr)
        return 2
    finally:
        conn.close()
    print(new_id)
    return 0


if __name__ == "__main__":
    sys.exit(main())
