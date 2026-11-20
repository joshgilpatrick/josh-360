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
from laptop import failure_kinds as kinds  # noqa: E402  (paths puts the repository root on sys.path)
from ledger import ticket_costs  # noqa: E402
from walker_lib import graphfile, runfolder  # noqa: E402  (graphs/tools, put on the path by paths)

RUNNER = "agent-manager"
STATES = ("working", "queued", "parked", "waiting", "stopped", "between")
COLUMNS = ("Step", "Kind", "Attempt", "Loops", "Tier", "Model", "Session", "Cost", "Agent Manager session", "Outcome",
           "Why it ended", "Jira status", "Started", "Ended")
# The reason codes `advance` writes when it abandons, retries or stops an attempt (JP-183: the shared table, plus the
# pre-JP-183 `spawn-refused`). Anything else in a session file is shown as "other", so the report never carries text from
# a run.
REASONS = tuple(sorted(set(kinds.REASONS) | {"spawn-refused"}))
_ID = re.compile(r"^[A-Za-z0-9._-]{1,80}$")
ENDED_LIMIT = 10


def _iso(epoch: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))


def _epoch(stamp: object) -> Optional[float]:
    try:
        return float(calendar.timegm(time.strptime(str(stamp), "%Y-%m-%dT%H:%M:%SZ")))
    except ValueError:
        return None


def run_row(conn: sqlite3.Connection, run: dict) -> dict:
    """One open run's row: its state, the step it is at and since when."""
    row = {"run": run["run"], "graph": run["graph"], "ticket": run["ticket"], "step": None, "state": "unreadable",
           "since": run["started_at"], "waiting_on": None}
    try:
        doc = runfolder.load(run["run"])
    except FileNotFoundError:
        return row
    stopped, waiting = doc.get("stopped"), doc.get("waiting")
    open_step = ledgerview.open_step(conn, run["run"])
    if stopped:
        row.update(state="stopped", step=stopped.get("step"), since=(open_step or {}).get("started_at") or row["since"])
    elif waiting:
        row.update(state="waiting", step=waiting.get("step"), since=waiting.get("since") or row["since"],
                   waiting_on=waiting.get("on"))       # a blocking follow-up's key (JP-175)
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
    opened = ledgerview.open_runs(conn, RUNNER)
    rows = [run_row(conn, r) for r in opened]
    counts = {"open": len(rows)}
    for state in STATES:
        counts[state] = sum(1 for r in rows if r["state"] == state)
    flag_after = float(cfg["wait_flag_days"]) * 86400
    exempt = set(cfg.get("wait_flag_exempt") or [])
    long_waits = []
    for r in rows:
        if r["state"] != "waiting" or "{}.{}".format(r["graph"], r["step"]) in exempt:
            continue
        since = _epoch(r["since"])
        if since is None or now - since >= flag_after:           # a time that cannot be read is not "recent"
            long_waits.append({"run": r["run"], "ticket": r["ticket"], "step": r["step"], "since": r["since"]})
    since_ended = _iso(now - float(cfg["ended_runs_days"]) * 86400)
    recent = ledgerview.ended_runs(conn, since_ended, RUNNER)
    ended = [dict(e, steps=run_report(conn, e["run"], root)["steps"]) for e in recent[:ENDED_LIMIT]]
    from . import where                                  # where builds on this module, so it is imported here
    snap = {
        "status": "off" if paths.is_off() else "ok", "host": cfg["host"], "runs": counts,
        "open_runs": [{k: r[k] for k in ("run", "graph", "ticket", "step", "state", "since", "waiting_on")} for r in rows],
        "sessions_live": len(sessionfile.live([r["run"] for r in rows])), "session_limit": cfg["session_limit"],
        "rails": paths.rails_loaded(),
        "stopped": [dict({"run": r["run"], "ticket": r["ticket"], "step": r["step"]}, **_stop_kind(r["run"]))
                    for r in rows if r["state"] == "stopped"],
        "waiting_over_7_days": long_waits, "ended_runs": ended}
    snap.update(where.ticket_rows(conn, now, opened, recent, root))     # JP-172: one row per ticket, no cost
    snap[where.COUNTS_KEY]["cost_fields"] = where.cost_fields(snap)
    return snap


def text(snap: dict) -> str:
    lines = ["runner {} (host {}), {} open run(s), {} of {} sessions live, rails {}".format(
        snap["status"], snap["host"], snap["runs"]["open"], snap["sessions_live"], snap["session_limit"],
        "loaded" if snap["rails"] else "NOT loaded")]
    for r in snap["open_runs"]:
        lines.append("{} {} {} {}{} since {}".format(r["ticket"] or r["run"], r["graph"], r["step"] or "-", r["state"],
                                                   " on " + r["waiting_on"] if r.get("waiting_on") else "", r["since"]))
    for r in snap["stopped"]:
        why = ""
        if r.get("kind") == kinds.NEEDS_FIX:
            why = ", needs a fix: {}".format(r.get("code"))
        elif r.get("kind") == kinds.MAY_CLEAR:
            why = ", stuck: {}".format(r.get("code"))
        lines.append("Stopped: {} at {} ({}){}".format(r["ticket"] or r["run"], r["step"], r["run"], why))
    for row in snap.get("tickets") or []:
        for item in row.get("refused") or []:
            lines.append("Refused: {} {} (last seen {}): {}".format(row["ticket"], item["graph"], item["last_at"], item["reason"]))
    if snap["waiting_over_7_days"]:
        lines.append("Waiting more than 7 days")
        for r in snap["waiting_over_7_days"]:
            lines.append("{} {} since {}".format(r["ticket"] or r["run"], r["step"], r["since"]))
    return "\n".join(lines)


def _stop_kind(run_id: str) -> dict:
    """A runner stop's kind and code (JP-183), both fixed words; {} for a walker stop (a cap, a failed gate)."""
    try:
        stopped = runfolder.load(run_id).get("stopped") or {}
    except (FileNotFoundError, ValueError):
        return {}
    kind, code = stopped.get("kind"), stopped.get("code")
    if kind not in kinds.KINDS:
        return {}
    return {"kind": kind, "code": code if code in REASONS else "other"}


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
    found = {"am_session": None, "reason": None, "failure_kind": None, "earlier_am_sessions": []}
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
    if doc.get("state") in ("abandoned", "stopped", "spawn_failed") and doc.get("reason"):
        found["reason"] = doc.get("reason") if doc.get("reason") in REASONS else "other"
        found["failure_kind"] = kinds.kind_of(found["reason"]) if found["reason"] != "other" else kinds.MAY_CLEAR
    found["earlier_am_sessions"] = [i for i in (_id(((e or {}).get("handle") or {}).get("am_session"))
                                                for e in (doc.get("earlier") or []) if isinstance(e, dict)) if i]
    if row.get("session") is None:
        found["session"] = _id(link.get("session_id"))
    return found


def run_report(conn: sqlite3.Connection, run_id: str, root: Optional[Path] = None, with_cost: bool = False) -> dict:
    """One run's step table. `with_cost` adds each step's cost, subagents included (JP-170). The published snapshot
    never asks for it: cost is for Josh's own command line, and the snapshot is pushed to GitHub where agents read it."""
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
    if with_cost:
        costs = ledgerview.run_costs(conn, run_id)
        for step in steps:
            found = costs.get((step["step"], step["attempt"], step["loop_count"]))
            row = ticket_costs.cost_fields(found) if found else {"cost_usd": None, "cost_pricing": None}
            step.update(row)
    return {"run": run_id, "graph": head[0], "ticket": head[1], "runner": head[2], "started_at": head[3], "end": head[4],
            "score": head[5], "steps": steps, "with_cost": with_cost}


def report_from_snapshot(snap: dict, run_id: str) -> dict:
    """The same report, from a published snapshot's `ended_runs` (how the proof page is built in the cloud)."""
    for item in snap.get("ended_runs") or []:
        if item.get("run") == run_id:
            return {"run": run_id, "graph": item["graph"], "ticket": item["ticket"], "runner": RUNNER,
                    "started_at": item.get("started_at"), "end": item["end"], "score": item["score"], "steps": item["steps"],
                    "with_cost": False}
    raise ValueError("run {} is not in that snapshot".format(run_id))


def _cost_cell(report: dict, step: dict) -> str:
    if not report.get("with_cost"):
        return "-"                                     # a published snapshot carries no cost
    return ticket_costs.cost_text(step.get("cost_usd"), step.get("cost_pricing")) if step.get("cost_pricing") else ""


def render(report: dict) -> str:
    def cell(value: object) -> str:
        return "" if value is None else str(value).replace("|", "/")

    ended = "Ended: {} ({})".format(report["end"], report["score"]) if report.get("end") else "Not ended yet"
    keys = ("step", "kind", "attempt", "loop_count", "tier", "model", "session", "cost", "am_session", "outcome", "reason",
            "jira_status", "started_at", "ended_at")
    lines = ["# {} · {} · {}".format(report.get("ticket") or "no ticket", report["graph"], report["run"]), "", ended,
             "", "| " + " | ".join(COLUMNS) + " |", "|" + " --- |" * len(COLUMNS)]
    def value(step: dict, k: str) -> object:
        if k == "cost":
            return _cost_cell(report, step)
        if k == "reason" and step.get("reason") and step.get("failure_kind"):
            return "{} ({})".format(step["reason"], step["failure_kind"])          # JP-183: why, and of which kind
        if k == "am_session" and step.get("earlier_am_sessions"):
            return "{} (earlier {})".format(step.get("am_session") or "-", ", ".join(step["earlier_am_sessions"]))
        return step.get(k)

    lines += ["| " + " | ".join(cell(value(step, k)) for k in keys) + " |" for step in report["steps"]]
    if not report.get("with_cost"):
        lines += ["", "Cost is not in a published snapshot; run `report --run <id>` on the laptop to see it."]
    return "\n".join(lines) + "\n"
