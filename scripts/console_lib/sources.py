"""The console's readers (JP-185): the ledger's graph tables, every log under ~/.josh-360/logs and the hook spool.

Python 3.9, standard library only. Every reader is read-only. A source that is missing or cannot be read is reported
once by name and skipped; it never stops the others. A log is followed like `tail -F`: when it is replaced (the job
runner keeps one old copy as `<name>.1`) or shrinks, it is read again from the start.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Optional, Tuple

from . import events as ev

JOB_HEADER = re.compile(r"^=== (\S+) exit (-?\d+)\s*$")
REPORT_LINE = re.compile(r"^\(report output, \d+ bytes\)$")
HOOK_LINE = re.compile(r"^(\S+) (\S+) (.*)$")
JOB_OUTPUT_LINES = 4          # output lines shown under one job run; the rest are in the job's own log
STAMPLESS_BACKLOG = 10        # lines shown at start from a log that has no times of its own


def home_paths(home: Path) -> Dict[str, Path]:
    return {"ledger": home / "state" / "ledger.db", "logs": home / "logs", "runner": home / "logs" / "runner",
            "spool": home / "state" / "ledger-spool"}


# ---------------------------------------------------------------------------------------------------------------
# The ledger

LEDGER_QUERIES = {
    "runs": ("SELECT id, run_id, graph_id, subject_ref, ticket_key, started_at FROM graph_runs "
             "WHERE {where} ORDER BY id", "started_at"),
    "steps": ("SELECT s.id, s.run_id, s.step_id, s.step_kind, s.attempt, s.tier, s.started_at, g.ticket_key "
              "FROM step_runs s LEFT JOIN graph_runs g ON g.run_id = s.run_id WHERE {where} ORDER BY s.id",
              "s.started_at"),
    "results": ("SELECT r.id, s.run_id, s.step_id, s.step_kind, s.attempt, r.outcome, r.note, r.version, r.ended_at, "
                "g.ticket_key FROM step_results r JOIN step_runs s ON s.id = r.step_run_id "
                "LEFT JOIN graph_runs g ON g.run_id = s.run_id WHERE {where} ORDER BY r.id", "r.ended_at"),
    "ends": ("SELECT e.id, e.run_id, e.end_name, e.score, e.ended_at, g.ticket_key, g.graph_id FROM run_ends e "
             "LEFT JOIN graph_runs g ON g.run_id = e.run_id WHERE {where} ORDER BY e.id", "e.ended_at"),
    "asks": ("SELECT a.id, a.run_id, a.question_key, a.question, a.ticket_key, a.asked_at, a.channel FROM asks a "
             "WHERE {where} ORDER BY a.id", "a.asked_at"),
    "comments": ("SELECT c.id, c.run_id, c.ticket_key, c.comment_id, c.via, c.delivered_at FROM comment_deliveries c "
                 "WHERE {where} ORDER BY c.id", "c.delivered_at"),
}


def _id_column(sql: str) -> str:
    """The table alias's id column for `id > ?` (the first selected column)."""
    first = sql.split()[1].rstrip(",")
    return first


def ledger_events(name: str, row: sqlite3.Row) -> Optional[ev.Event]:
    run, ticket = row["run_id"] if "run_id" in row.keys() else None, row["ticket_key"]
    if name == "runs":
        return ev.make(ev.normalise(row["started_at"]), "graph", "start",
                       "run started: {} on {}".format(row["graph_id"], row["subject_ref"]), ticket, run)
    if name == "steps":
        tier = " ({})".format(row["tier"]) if row["tier"] else ""
        return ev.make(ev.normalise(row["started_at"]), "graph", "start", "{} {} started, attempt {}{}".format(
            row["step_kind"], row["step_id"], row["attempt"], tier), ticket, run)
    if name == "results":
        note = " — {}".format(row["note"]) if row["note"] else ""
        again = " (corrected)" if (row["version"] or 1) > 1 else ""
        return ev.make(ev.normalise(row["ended_at"]), "graph", ev.outcome_kind(row["outcome"]),
                       "{} {} ended: {}{}{}".format(row["step_kind"], row["step_id"], row["outcome"], again, note),
                       ticket, run)
    if name == "ends":
        kind = {"success": "ok", "needs-josh": "needs"}.get(row["score"], "stop")
        return ev.make(ev.normalise(row["ended_at"]), "graph", kind, "run of {} ended: {} ({})".format(
            row["graph_id"] or "graph", row["end_name"], row["score"]), ticket, run)
    if name == "asks":
        question = ": {}".format(row["question"]) if row["question"] else ""
        return ev.make(ev.normalise(row["asked_at"]), "graph", "needs", "question for Josh at {} via {}{}".format(
            row["question_key"], row["channel"], question), ticket, run)
    if name == "comments":
        return ev.make(ev.normalise(row["delivered_at"]), "ledger", "info", "ticket comment {} passed on ({})".format(
            row["comment_id"], row["via"]), ticket, run)
    return None


class LedgerSource:
    """New rows of the graph tables, read-only, by id after the first read (which starts at `since`)."""

    label = "ledger"

    def __init__(self, path: Path, since: str) -> None:
        self.path, self.since = path, since
        self.last: Dict[str, int] = {}
        self.run_tickets: Dict[str, str] = {}

    def exists(self) -> bool:
        return self.path.is_file()

    def poll(self) -> List[ev.Event]:
        if not self.exists():
            return []
        out: List[ev.Event] = []
        try:
            conn = sqlite3.connect("file:{}?mode=ro".format(self.path), uri=True, timeout=2)
        except sqlite3.Error:
            return []
        conn.row_factory = sqlite3.Row
        try:
            self._tickets(conn)
            for name, (sql, stamp) in LEDGER_QUERIES.items():
                id_col = _id_column(sql)
                if name in self.last:
                    where, args = "{} > ?".format(id_col), (self.last[name],)
                else:
                    where, args = "{} >= ?".format(stamp), (self.since,)
                try:
                    rows = conn.execute(sql.format(where=where), args).fetchall()
                except sqlite3.Error:      # an older ledger without this table: skip the query, keep the rest
                    continue
                if name not in self.last:
                    self.last[name] = max([r[0] for r in rows] + [self._max_id(conn, id_col, sql)])
                for row in rows:
                    self.last[name] = max(self.last[name], row[0])
                    made = ledger_events(name, row)
                    if made is not None:
                        out.append(made._replace(order=row[0]))
        finally:
            conn.close()
        return out

    def _tickets(self, conn: sqlite3.Connection) -> None:
        try:
            for run_id, key in conn.execute("SELECT run_id, ticket_key FROM graph_runs WHERE ticket_key IS NOT NULL"):
                self.run_tickets[run_id] = key
        except sqlite3.Error:
            pass

    @staticmethod
    def _max_id(conn: sqlite3.Connection, id_col: str, sql: str) -> int:
        """The newest id in the query's table, so rows older than `since` are never shown later."""
        table = sql.split(" FROM ")[1].split()[0]
        alias_col = id_col.split(".")[-1]
        try:
            found = conn.execute("SELECT MAX({}) FROM {}".format(alias_col, table)).fetchone()[0]
        except sqlite3.Error:
            return 0
        return int(found or 0)


# ---------------------------------------------------------------------------------------------------------------
# Logs

Parser = Callable[[str, dict], Iterable[ev.Event]]


class LogTail:
    """Follow one file. `parser(line, state)` turns a line into events; `state` is the parser's own memory."""

    def __init__(self, path: Path, source: str, parser: Parser, stamped: bool = True) -> None:
        self.path, self.source, self.parser, self.stamped = path, source, parser, stamped
        self.offset, self.inode, self.partial = 0, None, ""
        self.state: dict = {"path": path}
        self.order = 0

    def poll(self, since: Optional[str], first: bool) -> List[ev.Event]:
        try:
            info = self.path.stat()
        except OSError:
            return []
        if self.inode is not None and (info.st_ino != self.inode or info.st_size < self.offset):
            self.offset, self.partial = 0, ""          # replaced or cut: read the new file from its start
        self.inode = info.st_ino
        if info.st_size == self.offset:
            return []
        try:
            with open(str(self.path), "rb") as handle:
                handle.seek(self.offset)
                data = handle.read()
        except OSError:
            return []
        self.offset += len(data)
        text = self.partial + data.decode("utf-8", errors="replace")
        lines = text.split("\n")
        self.partial = lines.pop()                      # an unfinished last line waits for its newline
        if first and not self.stamped:
            if since is not None and ev.iso_from_epoch(info.st_mtime) < since:
                return []
            lines = lines[-STAMPLESS_BACKLOG:]
        self.state["mtime"] = ev.iso_from_epoch(info.st_mtime)
        out: List[ev.Event] = []
        for line in lines:
            if not line.strip():
                continue
            for made in self.parser(line, self.state):
                self.order += 1
                if first and since is not None and made.at < since:
                    continue
                out.append(made._replace(order=self.order))
        return out


def runner_parser(line: str, state: dict) -> Iterable[ev.Event]:
    stamp, rest = ev.split_stamp(line)
    yield ev.make(stamp or state.get("mtime"), "runner", ev.classify(rest), rest)


def advance_parser(line: str, state: dict) -> Iterable[ev.Event]:
    run = state["path"].stem[len("run-"):]
    stamp, rest = ev.split_stamp(line)
    yield ev.make(stamp or state.get("mtime"), "advance", ev.classify(rest, "quiet"), rest, run=run)


def hooks_parser(line: str, state: dict) -> Iterable[ev.Event]:
    stamp, rest = ev.split_stamp(line)
    kind = "error" if (" blocked" in rest or " failed" in rest) else ev.classify(rest, "quiet")
    yield ev.make(stamp or state.get("mtime"), "hooks", kind, rest)


def job_parser(line: str, state: dict) -> Iterable[ev.Event]:
    """`=== <time> exit <n>` opens one job run. Under a failed run up to four output lines follow; under a clean run
    only the lines that look like an error, a stop, a start or a question. A line with its own time stands alone."""
    job = state["path"].stem
    header = JOB_HEADER.match(line)
    if header:
        stamp, code = ev.normalise(header.group(1)), int(header.group(2))
        state["stamp"], state["shown"], state["code"] = stamp, 0, code
        if code == 0:
            yield ev.make(stamp, "job", "quiet", "{} ran, exit 0".format(job))
        elif code == 124:
            yield ev.make(stamp, "job", "error", "{} timed out (exit 124)".format(job))
        else:
            yield ev.make(stamp, "job", "error", "{} failed, exit {}".format(job, code))
        return
    if REPORT_LINE.match(line.strip()):
        return
    stamp, rest = ev.split_stamp(line)
    if stamp:
        yield ev.make(stamp, "job", ev.classify(rest, "info"), "{}: {}".format(job, rest))
        return
    at = state.get("stamp") or state.get("mtime")
    # A job's JSON summary is counts ("failed": 0), whose words mean nothing here.
    kind = "quiet" if rest.lstrip().startswith(("{", "[")) else ev.classify(rest, "quiet")
    if state.get("code") == 0 and kind in ("quiet", "info", "ok"):
        return                                         # a clean run's routine output stays in its own log
    shown = state.get("shown", 0)
    state["shown"] = shown + 1
    if shown < JOB_OUTPUT_LINES:
        yield ev.make(at, "job", kind, "{}: │ {}".format(job, rest))
    elif shown == JOB_OUTPUT_LINES:
        yield ev.make(at, "job", "quiet", "{}: │ … more in logs/{}".format(job, state["path"].name))


def spool_parser(line: str, state: dict) -> Iterable[ev.Event]:
    try:
        doc = json.loads(line)
    except ValueError:
        return
    if not isinstance(doc, dict):
        return
    sid = str(doc.get("session_id") or "?")[:8]
    folder = os.path.basename(str(doc.get("cwd") or "").rstrip("/")) or "?"
    stamp = ev.normalise(doc.get("at"))
    if doc.get("event") == "SessionStart":
        yield ev.make(stamp, "session", "info", "session {} started by {} in {} ({})".format(
            sid, doc.get("started_by") or "?", folder, doc.get("source") or "?"))
    elif doc.get("event") == "SessionEnd":
        yield ev.make(stamp, "session", "quiet", "session {} ended ({}) in {}".format(
            sid, doc.get("reason") or "?", folder))


SOURCES = ("graph", "ledger", "runner", "advance", "job", "hooks", "session")


def log_files(home: Path) -> List[Tuple[Path, str, Parser, bool]]:
    """Every file the console follows right now, with its source tag, parser and whether its lines carry times."""
    paths = home_paths(home)
    found: List[Tuple[Path, str, Parser, bool]] = []
    runner = paths["runner"]
    if (runner / "runner.log").is_file():
        found.append((runner / "runner.log", "runner", runner_parser, True))
    for path in sorted(runner.glob("run-r-*.log")):
        found.append((path, "advance", advance_parser, False))
    for path in sorted(paths["logs"].glob("*.log")):
        if path.name == "hooks.log":
            found.append((path, "hooks", hooks_parser, True))
        else:
            found.append((path, "job", job_parser, True))
    for path in sorted(paths["spool"].glob("*.jsonl")):
        found.append((path, "session", spool_parser, True))
    return found
