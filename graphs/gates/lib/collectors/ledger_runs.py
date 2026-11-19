"""Collector `ledger-runs`: how many runs of one graph have ended since the watch began, and how they scored (JP-166).

Reads the ledger (`state/ledger.db`) read-only: it never creates the file and never writes to it. A run counts when its
newest end (`current_run_ends`) is at or after `since` and its graph id is the argument.
"""
from __future__ import annotations

import re
import sqlite3
import urllib.parse

from . import reading

FIELDS = {"events": "number", "success": "number", "neutral": "number", "needs_josh": "number"}
COUNTS_EVENTS = True
ARGUMENT = re.compile(r"^[a-z][a-z0-9-]{0,63}$")

QUERY = """
SELECT COUNT(*),
       COALESCE(SUM(x.score = 'success'), 0), COALESCE(SUM(x.score = 'neutral'), 0),
       COALESCE(SUM(x.score = 'needs-josh'), 0)
FROM graph_runs g JOIN current_run_ends x ON x.run_id = g.run_id
WHERE g.graph_id = ? AND x.ended_at >= ?
  AND NOT EXISTS (SELECT 1 FROM live_corrections c WHERE c.table_name = 'graph_runs' AND c.row_id = g.id)
"""


def read(argument: str, since: str, deps) -> dict:
    try:
        if ARGUMENT.fullmatch(argument or "") is None:
            return reading.take(None, FIELDS)
        path = reading.state_dir(deps) / "ledger.db"
        if not path.is_file():
            return reading.take(None, FIELDS)
        conn = sqlite3.connect("file:{}?mode=ro".format(urllib.parse.quote(str(path))), uri=True, timeout=5.0)
        try:
            events, success, neutral, needs_josh = conn.execute(QUERY, (argument, since)).fetchone()
        finally:
            conn.close()
        return reading.take({"events": events, "success": success, "neutral": neutral, "needs_josh": needs_josh}, FIELDS)
    except Exception:
        return reading.take(None, FIELDS)
