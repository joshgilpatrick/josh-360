"""The validation graph's checks (JP-167): the start rule is on, and no watch has run past its give-up time. Reads the
laptop copy's `graphs/runner/starts.json`, the ledger (read-only) and the run folders' watch files. It writes nothing,
and what it prints is a run id and a ticket key."""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import List, Optional

sys.dont_write_bytecode = True
from .core import FAIL, PASS, SKIP, Ctx, Result, check  # noqa: E402

GRACE = timedelta(days=1)       # a closed laptop takes no checks, so a watch is late only a day after its time
ROUND_FILE = re.compile(r"^round-(\d+)\.json$")
OPEN_VALIDATION_RUNS = ("SELECT r.run_id, r.ticket_key FROM graph_runs r WHERE r.graph_id = 'validation' "
                        "AND NOT EXISTS (SELECT 1 FROM run_ends e WHERE e.run_id = r.run_id) ORDER BY r.id")


def _when(text) -> Optional[datetime]:
    if not isinstance(text, str) or not text:
        return None
    try:
        return datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _lines(path: Path) -> List[dict]:
    try:
        raw = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    found = []
    for line in raw:
        try:
            parsed = json.loads(line)
        except ValueError:
            continue
        if isinstance(parsed, dict):
            found.append(parsed)
    return found


def _due(folder: Path) -> Optional[datetime]:
    """When the run's newest watch is due to give up, or None: no watch file, it has ended, or it has not begun."""
    rounds = []
    if folder.is_dir():
        rounds = sorted((int(m.group(1)), p) for p in folder.iterdir() for m in [ROUND_FILE.fullmatch(p.name)] if m)
    if not rounds:
        return None
    path = rounds[-1][1]
    try:
        plan = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(plan, dict):
        return None
    lines = _lines(path.with_name(path.stem + ".checks.jsonl"))
    if any(line.get("kind") == "end" for line in lines):
        return None
    began = [line for line in lines if line.get("kind") == "began"]
    begins = _when(plan.get("begins_at")) or (_when(began[-1].get("at")) if began else None)
    days = plan.get("give_up_days")
    if begins is None or not isinstance(days, int) or isinstance(days, bool):
        return None
    return begins + timedelta(days=days)


@check("graphs", "validation-watch")
def validation_watch(ctx: Ctx) -> Result:
    cid = "graphs.validation-watch"
    try:
        rules = json.loads((ctx.copy / "graphs" / "runner" / "starts.json").read_text(encoding="utf-8"))["graphs"]
        rule = rules.get("validation")
    except (OSError, ValueError, KeyError, AttributeError):
        return Result(cid, FAIL, "graphs/runner/starts.json cannot be read in the laptop's copy",
                      "python3 ~/.josh-360/repo/laptop/follow.py")
    if not isinstance(rule, dict) or rule.get("on") is not True:
        return Result(cid, FAIL, "the validation graph's start rule is {} in graphs/runner/starts.json, so no ticket in "
                      "Deployed is watched".format("off" if isinstance(rule, dict) else "missing"),
                      'set "on": true on the "validation" rule in graphs/runner/starts.json (in a cloud session, then merge)')
    try:
        conn = ctx.sqlite_ro(ctx.state / "ledger.db")
        try:
            runs = conn.execute(OPEN_VALIDATION_RUNS).fetchall()
        finally:
            conn.close()
    except Exception as err:  # noqa: BLE001  (a missing, locked or damaged ledger is one answer here: cannot be read)
        return Result(cid, SKIP, "the ledger cannot be read ({}), so open watches are not checked".format(
            type(err).__name__))
    runs_dir = Path(ctx.env.get("JOSH360_RUNS") or str(ctx.home / "runs"))
    late = []
    for run_id, ticket in runs:
        due = _due(runs_dir / str(run_id) / "work" / "watch")
        if due is not None and ctx.now > due + GRACE:
            late.append("{} ({})".format(run_id, ticket))
    if late:
        return Result(cid, FAIL, "{} watch(es) are more than a day past their give-up time: {}".format(
            len(late), "; ".join(late)),
            "read the run with `python3 ~/.josh-360/repo/graphs/runner/runner.py report --run <id>`; a watch that is "
            "stuck is a bug to report")
    return Result(cid, PASS, "rule on; {} watches open, none overdue".format(len(runs)))


TICKET_ROOT = "josh-360/tickets/"
NAME = re.compile(r"^(?P<key>[A-Z][A-Z0-9]*-\d+)\((?P<letter>[a-z]+)\) - \S.*$")


def _am_db(ctx: Ctx) -> Path:
    named = ctx.env.get("JOSH360_AM_DB")
    return Path(named) if named else ctx.user_home / "Library" / "Application Support" / "agent-manager" / "state.db"


@check("graphs", "agent-manager-groups")
def agent_manager_groups(ctx: Ctx) -> Result:
    """JP-173: each ticket's kept session is the only one in view, is named `<KEY>(<letter>) - <Step>`, and sits in the
    group for the status the runner last saw. Reads the runner's `state/runner/am-tickets.json` and Agent Manager's
    database, read-only; never Jira, so the offline daily job can pass. Nothing in view is a skip, not a pass."""
    cid = "graphs.agent-manager-groups"
    path = ctx.state / "runner" / "am-tickets.json"
    try:
        tickets = json.loads(path.read_text(encoding="utf-8"))["tickets"] if path.is_file() else {}
        if not isinstance(tickets, dict):
            raise ValueError("tickets is not an object")
    except (OSError, ValueError, KeyError, TypeError) as err:
        return Result(cid, FAIL, "the runner's {} cannot be read ({})".format(ctx.tilde(path), type(err).__name__),
                      "look at the file; the runner rewrites it on its next tick only when it can read it")
    try:
        conn = ctx.sqlite_ro(_am_db(ctx))
        try:
            rows = conn.execute("SELECT id, name, group_name, archived FROM sessions").fetchall()
        finally:
            conn.close()
    except Exception as err:  # noqa: BLE001  (a missing, locked or changed database is one answer: cannot be read)
        return Result(cid, SKIP, "Agent Manager's database cannot be read ({})".format(type(err).__name__))
    by_id = {r[0]: r for r in rows}
    problems, shown, known = [], 0, set()
    for key in sorted(tickets):
        rec = tickets[key] if isinstance(tickets[key], dict) else {}
        sessions = [s for s in rec.get("sessions") or [] if isinstance(s, dict)]
        known.update(s.get("am_session") for s in sessions)
        live = [by_id[s["am_session"]] for s in sessions if s.get("am_session") in by_id and not by_id[s["am_session"]][3]]
        if not live:
            continue
        shown += 1
        if len(live) > 1:
            problems.append("{} has {} sessions in view".format(key, len(live)))
        for row in live:
            match = NAME.match(row[1] or "")
            if not match or match.group("key") != key:
                problems.append("{}'s session {} is not named {}(<letter>) - <Step>".format(key, row[0], key))
            if rec.get("group") and row[2] != rec["group"]:
                problems.append("{}'s session {} is in '{}', not '{}'".format(key, row[0], row[2] or "(root)", rec["group"]))
    for row in rows:
        if not row[3] and str(row[2] or "").startswith(TICKET_ROOT) and row[0] not in known:
            problems.append("session {} is in '{}' but the runner has no record of it".format(row[0], row[2]))
    if problems:
        return Result(cid, FAIL, "; ".join(problems[:5]) + ("" if len(problems) <= 5 else " (and {} more)".format(
            len(problems) - 5)), "the runner's next tick moves and archives what it can; read "
            "~/.josh-360/logs/runner/runner.log for an Agent Manager call that keeps failing")
    if not shown:
        return Result(cid, SKIP, "no ticket has a graph session in view, so there is nothing to check")
    return Result(cid, PASS, "{} ticket(s) in view, each with one session in its status group".format(shown))
