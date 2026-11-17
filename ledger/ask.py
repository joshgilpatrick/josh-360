"""The one command working agents use to read the ledger (JP-107, Task 7). Python 3.9, standard library only.

    python3 ledger/ask.py home       --session <id>
    python3 ledger/ask.py ticket     --key <KEY>
    python3 ledger/ask.py find       (--folder <path> | --branch <name>) [--since <date>]
    python3 ledger/ask.py precedent  --category <category> --system <name> --work-type <kind>
    python3 ledger/ask.py run        --run <id>
    python3 ledger/ask.py changes    (--system <name> | --repo <owner/name>) [--since <date>] [--live]

Six fixed queries and no SQL, no file path. Each answer is at most 20 rows and 4 KB of JSON (rows are cut, never
strings). None returns friction facts, usage, debriefs, cost, priority or any measure. The ledger is opened read-only;
the one write is the `memory_lookups` row that `precedent` adds, made through a second connection.
Exit 0 with the answer, 2 for bad input or a missing ledger.
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path
from typing import Callable, Dict, List, Optional, TextIO

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from ledger import _repo  # noqa: E402,F401
from laptop import common  # noqa: E402
from ledger import db  # noqa: E402

MAX_ROWS = 20
MAX_BYTES = 4096
BY = "ledger/ask.py"
LIVE_NOTE = "not built yet (JP-109)"

_SUMMARY_LINE = """(SELECT substr(m.lines, 1, instr(m.lines || char(10), char(10)) - 1) FROM current_session_summaries m
                    WHERE m.session_uid = {uid} ORDER BY m.episode DESC LIMIT 1)"""

# The spec's precedent query, word for word (tests/test_ledger_schema.py holds the same text).
PRECEDENT_SQL = """SELECT id, answer, decided_at, ticket_key FROM current_decisions
WHERE category = :category AND system IS :system AND work_type IS :work_type
ORDER BY decided_at DESC, id DESC LIMIT 3"""

HOME_SQL = """SELECT s.session_uid, h.ticket_key, h.tracker, h.epic_key, h.system, h.method
FROM sessions s JOIN current_homes h ON h.session_uid = s.session_uid
WHERE s.session_uid = :session OR s.tool_session_id = :session
ORDER BY s.id LIMIT 20"""

TICKET_SQL = """SELECT * FROM (
  SELECT 'session' AS kind, s.session_uid AS id, COALESCE(e.quiet_at, s.started_at) AS date, e.title AS title,
         """ + _SUMMARY_LINE.format(uid="s.session_uid") + """ AS summary_line, NULL AS graph, NULL AS ended
  FROM sessions s
  LEFT JOIN current_session_episodes e ON e.session_uid = s.session_uid
       AND e.episode = (SELECT MAX(episode) FROM current_session_episodes WHERE session_uid = s.session_uid)
  WHERE EXISTS (SELECT 1 FROM ticket_links t WHERE t.session_uid = s.session_uid AND t.ticket_key = :key
                AND NOT EXISTS (SELECT 1 FROM live_corrections c WHERE c.table_name = 'ticket_links' AND c.row_id = t.id))
  UNION ALL
  SELECT 'run', g.run_id, g.started_at, NULL, NULL, g.graph_id, x.end_name
  FROM graph_runs g LEFT JOIN current_run_ends x ON x.run_id = g.run_id
  WHERE g.ticket_key = :key
    AND NOT EXISTS (SELECT 1 FROM live_corrections c WHERE c.table_name = 'graph_runs' AND c.row_id = g.id)
) ORDER BY date DESC, id LIMIT 20"""

_FIND = """SELECT s.session_uid, e.quiet_at AS date, e.title, e.folder, e.branch,
       """ + _SUMMARY_LINE.format(uid="s.session_uid") + """ AS summary_line,
       (SELECT h.ticket_key FROM current_homes h WHERE h.session_uid = s.session_uid) AS ticket
FROM sessions s JOIN current_session_episodes e ON e.session_uid = s.session_uid
     AND e.episode = (SELECT MAX(episode) FROM current_session_episodes WHERE session_uid = s.session_uid)
WHERE {where} AND e.quiet_at >= :since
ORDER BY e.quiet_at DESC LIMIT 20"""
FIND_FOLDER_SQL = _FIND.format(where="(e.folder = :folder OR substr(e.folder, 1, length(:folder) + 1) = :folder || '/')")
FIND_BRANCH_SQL = _FIND.format(where="e.branch = :branch")

RUN_SQL = """SELECT step, attempt, outcome, loop_count, tier, started_at, ended_at FROM step_ledger
WHERE run = :run ORDER BY started_at, attempt, step LIMIT 20"""

# The spec's changelog query, with the repository form added.
_CHANGES = """SELECT e.quiet_at, h.ticket_key, h.system, s.session_uid,
       (SELECT r.value FROM session_refs r WHERE r.session_uid = s.session_uid AND r.kind = 'pr'
        ORDER BY r.observed_at DESC LIMIT 1) AS pull_request,
       """ + _SUMMARY_LINE.format(uid="s.session_uid") + """ AS summary_line
FROM sessions s
JOIN current_homes h ON h.session_uid = s.session_uid
JOIN current_session_episodes e ON e.session_uid = s.session_uid
     AND e.episode = (SELECT MAX(episode) FROM current_session_episodes WHERE session_uid = s.session_uid)
WHERE {where} AND e.quiet_at >= :since
  AND EXISTS (SELECT 1 FROM session_refs r WHERE r.session_uid = s.session_uid AND r.kind IN ('commit', 'pr'))
ORDER BY e.quiet_at DESC LIMIT 20"""
CHANGES_SYSTEM_SQL = _CHANGES.format(where="h.system = :system")
CHANGES_REPO_SQL = _CHANGES.format(where="e.repo = :repo")


def _rows(conn: sqlite3.Connection, sql: str, params: Dict[str, object]) -> List[Dict[str, object]]:
    cur = conn.execute(sql, params)
    names = [d[0] for d in cur.description]
    return [dict(zip(names, row)) for row in cur.fetchall()]


def _need(args: dict, *names: str) -> None:
    missing = [n for n in names if args.get(n) in (None, "")]
    if missing:
        raise ValueError("missing argument: " + ", ".join("--" + m.replace("_", "-") for m in missing))


def _precedent(conn: sqlite3.Connection, args: dict) -> List[Dict[str, object]]:
    _need(args, "category", "system", "work_type")
    params = {"category": args["category"], "system": args["system"], "work_type": args["work_type"]}
    rows = _rows(conn, PRECEDENT_SQL, params)
    path = conn.execute("PRAGMA database_list").fetchone()[2]
    writer = db.connect(Path(path))  # the one write this command makes: that the lookup happened, and what it found
    try:
        writer.execute(
            "INSERT INTO memory_lookups (category, question_key, system, work_type, found, looked_up_at, recorded_by) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (params["category"], args.get("question_key") or "precedent-lookup", params["system"],
             params["work_type"], len(rows), common.now_utc(), BY))
    finally:
        writer.close()
    return rows


def query(conn: sqlite3.Connection, name: str, args: dict) -> List[Dict[str, object]]:
    """The rows of one named query. ValueError for an unknown name or a missing argument."""
    since = args.get("since") or ""
    if name == "home":
        _need(args, "session")
        return _rows(conn, HOME_SQL, {"session": args["session"]})
    if name == "ticket":
        _need(args, "key")
        return _rows(conn, TICKET_SQL, {"key": args["key"]})
    if name == "find":
        if bool(args.get("folder")) == bool(args.get("branch")):
            raise ValueError("give exactly one of --folder or --branch")
        if args.get("folder"):
            return _rows(conn, FIND_FOLDER_SQL, {"folder": str(args["folder"]).rstrip("/") or "/", "since": since})
        return _rows(conn, FIND_BRANCH_SQL, {"branch": args["branch"], "since": since})
    if name == "precedent":
        return _precedent(conn, args)
    if name == "run":
        _need(args, "run")
        return _rows(conn, RUN_SQL, {"run": args["run"]})
    if name == "changes":
        if bool(args.get("system")) == bool(args.get("repo")):
            raise ValueError("give exactly one of --system or --repo")
        if args.get("system"):
            return _rows(conn, CHANGES_SYSTEM_SQL, {"system": args["system"], "since": since})
        return _rows(conn, CHANGES_REPO_SQL, {"repo": args["repo"], "since": since})
    raise ValueError("unknown query: {}".format(name))


def render(name: str, rows: List[Dict[str, object]], extra: Optional[dict] = None) -> str:
    """The JSON the command prints: at most MAX_ROWS rows and MAX_BYTES bytes. Whole rows are dropped, never cut."""
    kept = rows[:MAX_ROWS]

    def text(items: list) -> str:
        body = {"query": name, "rows": items, "truncated": len(items) < len(rows)}
        body.update(extra or {})
        return json.dumps(body, sort_keys=True, ensure_ascii=False)

    while kept and len(text(kept).encode("utf-8")) > MAX_BYTES:
        kept.pop()
    return text(kept)


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="name", required=True)
    sub.add_parser("home").add_argument("--session", required=True)
    sub.add_parser("ticket").add_argument("--key", required=True)
    f = sub.add_parser("find")
    group = f.add_mutually_exclusive_group(required=True)
    group.add_argument("--folder")
    group.add_argument("--branch")
    f.add_argument("--since")
    q = sub.add_parser("precedent")
    q.add_argument("--category", required=True)
    q.add_argument("--system", required=True)
    q.add_argument("--work-type", required=True, dest="work_type")
    q.add_argument("--question-key", dest="question_key")
    sub.add_parser("run").add_argument("--run", required=True)
    c = sub.add_parser("changes")
    group = c.add_mutually_exclusive_group(required=True)
    group.add_argument("--system")
    group.add_argument("--repo")
    c.add_argument("--since")
    c.add_argument("--live", action="store_true")
    return p


def open_read_only(path: Path) -> sqlite3.Connection:
    if not path.is_file():
        raise FileNotFoundError("there is no ledger at {}".format(path))
    conn = sqlite3.connect("file:{}?mode=ro".format(path), uri=True, timeout=5.0)
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def main(argv: Optional[List[str]] = None, out: Optional[TextIO] = None, path: Optional[Path] = None) -> int:
    out = out or sys.stdout
    args = vars(_parser().parse_args(argv))  # argparse exits 2 on bad input
    name = args.pop("name")
    live = args.pop("live", False)
    try:
        conn = open_read_only(path or db.ledger_path())
    except (FileNotFoundError, sqlite3.Error) as e:
        print("ask: {}".format(e), file=sys.stderr)
        return 2
    try:
        rows = query(conn, name, args)
    except ValueError as e:
        print("ask: {}".format(e), file=sys.stderr)
        return 2
    finally:
        conn.close()
    out.write(render(name, rows, {"live": LIVE_NOTE} if live else None) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
