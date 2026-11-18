"""What the runner reports: a snapshot of the open runs, and a report of one run (JP-117).

Python 3.9, standard library only. Read-only: it reads the ledger, the run folders and the session files, and never
writes. Both documents hold ids, step names, outcomes, counts and times only: no note, question, answer or summary
text from a run, because the snapshot is pushed to GitHub by the job runner.
"""
from __future__ import annotations

import calendar
import re
import sqlite3
import time
from pathlib import Path
from typing import List, Optional

from . import ledgerview, paths, sessionfile
from walker_lib import graphfile, runfolder  # noqa: E402  (graphs/tools, put on the path by paths)

RUNNER = "agent-manager"
STATES = ("working", "queued", "parked", "waiting", "stopped", "between")
COLUMNS = ("Step", "Kind", "Attempt", "Loops", "Tier", "Model", "Session", "Agent Manager session", "Outcome",
           "Why it ended", "Jira status", "Started", "Ended")
# The words `advance` writes when it abandons an attempt. Anything else in a session file is shown as "other", so the
# report never carries text from a run.
REASONS = ("spawn-refused", "never-started", "bad-result", "time-cap", "session-gone", "rested-without-result")
_ID = re.compile(r"^[A-Za-z0-9._-]{1,80}$")
ENDED_LIMIT = 10


def _iso(epoch: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))


def _epoch(stamp: object) -> Optional[float]:
    try:
        return float(calendar.timegm(time.strptime(str(stamp), "%Y-%m-%dT%H:%M:%SZ")))
    except ValueError:
        return None


def _run_row(conn: sqlite3.Connection, run: dict) -> dict:
    """One open run's row: its state, the step it is at and since when."""
    row = {"run": run["run"], "graph": run["graph"], "ticket": run["ticket"], "step": None, "state": "unreadable",
           "since": run["started_at"]}
    try:
        doc = runfolder.load(run["run"])
    except FileNotFoundError:
        return row
    stopped, waiting = doc.get("stopped"), doc.get("waiting")
    open_step = ledgerview.open_step(conn, run["run"])
    if stopped:
        row.update(state="stopped", step=stopped.get("step"), since=(open_step or {}).get("started_at") or row["since"])
    elif waiting:
        row.update(state="waiting", step=waiting.get("step"), since=waiting.get("since") or row["since"])
    elif open_step is None:
        row["state"] = "between"
    elif open_step["kind"] == "ask":
        row.update(state="parked", step=open_step["step"], since=open_step["started_at"])
    elif open_step["kind"] == "role":
        live = [d for d in sessionfile.live([run["run"]])
                if d.get("state") == "unreadable" or (d.get("step"), d.get("attempt")) == (open_step["step"], open_step["attempt"])]
        row.update(state="working" if live else "queued", step=open_step["step"], since=open_step["started_at"])
    else:
        row.update(state="between", step=open_step["step"], since=open_step["started_at"])
    return row


def snapshot(conn: sqlite3.Connection, now: float, root: Optional[Path] = None) -> dict:
    cfg = paths.settings()
    rows = [_run_row(conn, r) for r in ledgerview.open_runs(conn, RUNNER)]
    counts = {"open": len(rows)}
    for state in STATES:
        counts[state] = sum(1 for r in rows if r["state"] == state)
    flag_after = float(cfg["wait_flag_days"]) * 86400
    long_waits = []
    for r in rows:
        if r["state"] != "waiting":
            continue
        since = _epoch(r["since"])
        if since is None or now - since >= flag_after:           # a time that cannot be read is not "recent"
            long_waits.append({"run": r["run"], "ticket": r["ticket"], "step": r["step"], "since": r["since"]})
    since_ended = _iso(now - float(cfg["ended_runs_days"]) * 86400)
    ended = [dict(e, steps=run_report(conn, e["run"], root)["steps"])
             for e in ledgerview.ended_runs(conn, since_ended, RUNNER)[:ENDED_LIMIT]]
    return {
        "status": "off" if paths.is_off() else "ok", "host": cfg["host"], "runs": counts,
        "open_runs": [{k: r[k] for k in ("run", "graph", "ticket", "step", "state", "since")} for r in rows],
        "sessions_live": len(sessionfile.live([r["run"] for r in rows])), "session_limit": cfg["session_limit"],
        "rails": paths.rails_loaded(),
        "stopped": [{"run": r["run"], "ticket": r["ticket"], "step": r["step"]} for r in rows if r["state"] == "stopped"],
        "waiting_over_7_days": long_waits, "ended_runs": ended}


def text(snap: dict) -> str:
    lines = ["runner {} (host {}), {} open run(s), {} of {} sessions live, rails {}".format(
        snap["status"], snap["host"], snap["runs"]["open"], snap["sessions_live"], snap["session_limit"],
        "loaded" if snap["rails"] else "NOT loaded")]
    for r in snap["open_runs"]:
        lines.append("{} {} {} {} since {}".format(r["ticket"] or r["run"], r["graph"], r["step"] or "-", r["state"], r["since"]))
    for r in snap["stopped"]:
        lines.append("Stopped: {} at {} ({})".format(r["ticket"] or r["run"], r["step"], r["run"]))
    if snap["waiting_over_7_days"]:
        lines.append("Waiting more than 7 days")
        for r in snap["waiting_over_7_days"]:
            lines.append("{} {} since {}".format(r["ticket"] or r["run"], r["step"], r["since"]))
    return "\n".join(lines)


def _graph(graph_id: str, root: Optional[Path]):
    try:
        return graphfile.load(graph_id, root=paths.graphs_root(root) or graphfile.GRAPHS, live_check=False)
    except Exception:  # noqa: BLE001  (a graph that is gone or damaged only costs the Jira status column)
        return None


def _id(value) -> Optional[str]:
    return value if isinstance(value, str) and _ID.match(value) else None


def _attempt_sessions(run_id: str, row: dict) -> dict:
    """A role attempt's Agent Manager session, its Claude Code session when the ledger has none yet (an abandoned
    attempt never records one), and why the runner abandoned it, from the attempt's session and link files."""
    found = {"am_session": None, "reason": None}
    if row["kind"] != "role":
        return found
    try:
        doc = sessionfile.read(run_id, row["step"], row["attempt"]) or {}
        link = sessionfile.read_link(run_id, row["step"], row["attempt"]) or {}
    except sessionfile.Unreadable:
        found["reason"] = "unreadable"
        return found
    handle = doc.get("handle") if isinstance(doc.get("handle"), dict) else {}
    found["am_session"] = _id(handle.get("am_session")) or _id(link.get("am_session"))
    if doc.get("state") == "abandoned":
        found["reason"] = doc.get("reason") if doc.get("reason") in REASONS else "other"
    if row.get("session") is None:
        found["session"] = _id(link.get("session_id"))
    return found


def run_report(conn: sqlite3.Connection, run_id: str, root: Optional[Path] = None) -> dict:
    head = conn.execute("SELECT g.graph_id, g.ticket_key, g.runner, g.started_at, e.end_name, e.score FROM graph_runs g "
                        "LEFT JOIN current_run_ends e ON e.run_id = g.run_id WHERE g.run_id = ?", (run_id,)).fetchone()
    if head is None:
        raise ValueError("there is no run {}".format(run_id))
    graph = _graph(head[0], root)
    steps = []
    for row in ledgerview.run_rows(conn, run_id):
        status = graph.stretch_status(row["step"]) if graph is not None and row["step"] in graph.steps else None
        steps.append({"step": row["step"], "kind": row["kind"], "attempt": row["attempt"], "loop_count": row["loop_count"],
                      "tier": row["tier"], "model": row["model"], "session": row["session"], "outcome": row["outcome"],
                      "jira_status": status, "started_at": row["started_at"], "ended_at": row["ended_at"]})
        steps[-1].update(_attempt_sessions(run_id, steps[-1]))
    return {"run": run_id, "graph": head[0], "ticket": head[1], "runner": head[2], "started_at": head[3], "end": head[4],
            "score": head[5], "steps": steps}


def report_from_snapshot(snap: dict, run_id: str) -> dict:
    """The same report, from a published snapshot's `ended_runs` (how the proof page is built in the cloud)."""
    for item in snap.get("ended_runs") or []:
        if item.get("run") == run_id:
            return {"run": run_id, "graph": item["graph"], "ticket": item["ticket"], "runner": RUNNER,
                    "started_at": item.get("started_at"), "end": item["end"], "score": item["score"], "steps": item["steps"]}
    raise ValueError("run {} is not in that snapshot".format(run_id))


def render(report: dict) -> str:
    def cell(value: object) -> str:
        return "" if value is None else str(value).replace("|", "/")

    ended = "Ended: {} ({})".format(report["end"], report["score"]) if report.get("end") else "Not ended yet"
    keys = ("step", "kind", "attempt", "loop_count", "tier", "model", "session", "am_session", "outcome", "reason",
            "jira_status", "started_at", "ended_at")
    lines = ["# {} · {} · {}".format(report.get("ticket") or "no ticket", report["graph"], report["run"]), "", ended,
             "", "| " + " | ".join(COLUMNS) + " |", "|" + " --- |" * len(COLUMNS)]
    lines += ["| " + " | ".join(cell(step.get(k)) for k in keys) + " |" for step in report["steps"]]
    return "\n".join(lines) + "\n"
