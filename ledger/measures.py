"""The measures, as stored queries over the ledger (JP-112). Python 3.9, standard library only.

For Josh and Josh 360's own scripts (the weekly review, later the dashboard). Working agents are never given this
command: they read the ledger only through `ledger/ask.py`, which cannot return any of it (the vision: agents that see
the measures learn to game them). The database file is not a security boundary; the guard is what each command exposes.

    python3 ledger/measures.py headline     [--since D] [--until D] [--finished KEYS | --live]
    python3 ledger/measures.py first-time   [--since D] [--until D]
    python3 ledger/measures.py spend        [--since D] [--until D]
    python3 ledger/measures.py instructions [--since D] [--until D]
    python3 ledger/measures.py loose-ends
    python3 ledger/measures.py ticket <KEY> [--json]
    python3 ledger/measures.py all          [same flags as headline]

Dates are YYYY-MM-DD; --until is inclusive. The default is the last 28 days. The ledger is opened read-only and every
answer is JSON on stdout (exit 0), or exit 2 with a line on stderr for bad input or a missing ledger.

`ticket` (JP-170) lists every session on one ticket, the graph step each did and what it cost, with each session's
subagents folded in and a total at the bottom. It is the one measure that prints a table; `--json` gives the same rows
as JSON. See `ledger/ticket_costs.py`.

The headline is two numbers read side by side: Josh's messages per finished ticket, and the share of work signed off
first time. If the first falls while the second holds, the system is working; if both fall, it is only skipping Josh.
"Finished" is not in the ledger, because what an agent says about its own work is a claim: it comes from Jira's status
(`--live`, a read-only call, or `--finished` with keys the caller has already read) and from graph runs that ended
`finished`. A ticket with no answer is not counted as finished.
"""
from __future__ import annotations

import argparse
import calendar
import json
import sqlite3
import statistics
import sys
import time
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Optional, Sequence, Set, Tuple

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from ledger import _repo  # noqa: E402,F401
from laptop import common  # noqa: E402
from ledger import db, ticket_costs  # noqa: E402

DEFAULT_DAYS = 28
LIST_LIMIT = 20
READY = "ready-for-human"      # a PR audit's verdict label ends with this when the PR passed

NOT_CORRECTED = "NOT EXISTS (SELECT 1 FROM live_corrections c WHERE c.table_name = '{t}' AND c.row_id = {a}.id)"

# One row per ticket home: Josh's messages in the episodes that went quiet in the window. A session with no ticket
# home has ticket_key NULL and is reported as unattributed.
MESSAGES_SQL = """
SELECT h.ticket_key,
       COALESCE(SUM(CASE f.fact WHEN 'josh_messages_answer' THEN f.value END), 0),
       COALESCE(SUM(CASE f.fact WHEN 'josh_messages_unprompted' THEN f.value END), 0),
       COUNT(DISTINCT e.session_uid)
FROM current_session_episodes e
LEFT JOIN current_homes h ON h.session_uid = e.session_uid
LEFT JOIN session_facts f ON f.session_uid = e.session_uid AND f.episode = e.episode
     AND f.fact IN ('josh_messages_answer', 'josh_messages_unprompted') AND """ + NOT_CORRECTED.format(
    t="session_facts", a="f") + """
WHERE e.quiet_at >= :since AND e.quiet_at < :until
GROUP BY h.ticket_key"""

# A ticket whose newest graph run ended `finished`.
RUN_FINISHED_SQL = """
SELECT g.ticket_key FROM graph_runs g JOIN current_run_ends x ON x.run_id = g.run_id
WHERE g.ticket_key IS NOT NULL AND x.end_name = 'finished'
  AND """ + NOT_CORRECTED.format(t="graph_runs", a="g") + """
  AND g.id = (SELECT g2.id FROM graph_runs g2 WHERE g2.ticket_key = g.ticket_key
              AND """ + NOT_CORRECTED.format(t="graph_runs", a="g2") + """ ORDER BY g2.started_at DESC, g2.id DESC LIMIT 1)"""

# Runs that ended well (a ticket's graph run signed off). It was sent back when a later run names it as its previous
# run (JP-140: "a run that returned later"), and it was not first time when it had a previous run itself.
SIGNED_RUNS_SQL = """
SELECT g.run_id, g.previous_run_id IS NOT NULL,
       EXISTS (SELECT 1 FROM graph_runs n WHERE n.previous_run_id = g.run_id AND """ + NOT_CORRECTED.format(
    t="graph_runs", a="n") + """)
FROM graph_runs g JOIN current_run_ends x ON x.run_id = g.run_id
WHERE g.subject_kind <> 'pr' AND x.score = 'success' AND x.ended_at >= :since AND x.ended_at < :until
  AND """ + NOT_CORRECTED.format(t="graph_runs", a="g")

# Each audit round of a PR (action-triage's audit, recorded as a run of the graph `pr-audit`, one step `audit` whose
# outcome is the verdict label).
AUDIT_ROUNDS_SQL = """
SELECT g.subject_ref, l.outcome, l.ended_at
FROM graph_runs g JOIN step_ledger l ON l.run = g.run_id AND l.step = 'audit'
WHERE g.graph_source = 'external' AND g.graph_id = 'pr-audit' AND g.subject_kind = 'pr'
  AND """ + NOT_CORRECTED.format(t="graph_runs", a="g") + """
ORDER BY g.subject_ref, g.started_at, g.id"""

SESSION_TICKETS_SQL = """
SELECT DISTINCT h.ticket_key, e.session_uid
FROM current_session_episodes e JOIN current_homes h ON h.session_uid = e.session_uid
WHERE h.ticket_key IS NOT NULL AND e.quiet_at >= :since AND e.quiet_at < :until"""

SESSION_SECONDS_SQL = """
SELECT e.session_uid,
       COALESCE(SUM(CASE f.fact WHEN 'seconds_working' THEN f.value END), 0),
       COALESCE(SUM(CASE f.fact WHEN 'seconds_waiting_on_josh' THEN f.value END), 0)
FROM current_session_episodes e
JOIN session_facts f ON f.session_uid = e.session_uid AND f.episode = e.episode
     AND f.fact IN ('seconds_working', 'seconds_waiting_on_josh') AND """ + NOT_CORRECTED.format(
    t="session_facts", a="f") + """
WHERE e.quiet_at >= :since AND e.quiet_at < :until
GROUP BY e.session_uid"""

STEP_SPEND_SQL = """
SELECT g.ticket_key, c.step, COUNT(*), ROUND(COALESCE(SUM(c.cost_usd), 0), 4)
FROM step_costs_rolled_up c JOIN graph_runs g ON g.run_id = c.run
WHERE g.ticket_key IS NOT NULL AND g.started_at >= :since AND g.started_at < :until
GROUP BY g.ticket_key, c.step ORDER BY g.ticket_key, c.step"""

INSTRUCTION_SQL = """
SELECT f.value FROM current_session_episodes e
JOIN session_facts f ON f.session_uid = e.session_uid AND f.episode = e.episode
     AND f.fact = 'instruction_bytes_loaded' AND """ + NOT_CORRECTED.format(t="session_facts", a="f") + """
WHERE e.quiet_at >= :since AND e.quiet_at < :until"""

UNUSED_SQL = """
SELECT u.item_kind, u.item_name, COUNT(*) AS episodes
FROM session_usage u JOIN current_session_episodes e ON e.session_uid = u.session_uid AND e.episode = u.episode
WHERE e.quiet_at >= :since AND e.quiet_at < :until AND u.item_kind IN ('skill', 'agent', 'mcp-server')
GROUP BY u.item_kind, u.item_name HAVING SUM(u.uses) = 0
ORDER BY episodes DESC, u.item_kind, u.item_name LIMIT {limit}""".format(limit=LIST_LIMIT)

STATUS_PATH = "/rest/api/3/issue/{}?fields=status"


def _window(since: str, until: str) -> Dict[str, str]:
    return {"since": since, "until": until}


def finished_by_runs(conn: sqlite3.Connection) -> Set[str]:
    return {row[0] for row in conn.execute(RUN_FINISHED_SQL)}


def live_finished(fetch: Optional[Callable[[str], Optional[dict]]], keys: Iterable[str]) -> Tuple[Set[str], List[str]]:
    """(tickets Jira says are Done, tickets whose status could not be read). One read-only call per ticket; a failed
    read is unknown, never "not finished" and never "finished"."""
    done: Set[str] = set()
    unknown: List[str] = []
    for key in sorted(set(keys)):
        data = fetch(STATUS_PATH.format(key)) if fetch else None
        category = (((data or {}).get("fields") or {}).get("status") or {}).get("statusCategory") or {}
        if not category.get("key"):
            unknown.append(key)
        elif category["key"] == "done":
            done.add(key)
    return done, unknown


def first_time_signoff(conn: sqlite3.Connection, since: str, until: str) -> dict:
    """The share of work signed off without being sent back: ticket graph runs that ended well and were never followed
    by another run on the ticket, and PRs whose first audit round passed, over all that were signed off in the window.
    A PR is signed off when its newest audit round ended `ready-for-human`. Work signed off very recently may still be
    sent back; the share is read again later."""
    runs = conn.execute(SIGNED_RUNS_SQL, _window(since, until)).fetchall()
    run_first = sum(1 for _, has_previous, sent_back in runs if not has_previous and not sent_back)
    rounds: Dict[str, List[Tuple[str, str]]] = {}
    for ref, outcome, ended in conn.execute(AUDIT_ROUNDS_SQL):
        rounds.setdefault(ref, []).append((outcome or "", ended or ""))
    pr_signed = pr_first = 0
    for found in rounds.values():
        newest_outcome, newest_end = found[-1]
        if READY in newest_outcome and since <= newest_end < until:
            pr_signed += 1
            pr_first += 1 if READY in found[0][0] else 0
    signed, first = len(runs) + pr_signed, run_first + pr_first
    return {"measure": "first-time-signoff", "since": since, "until": until,
            "signed_off": signed, "first_time": first, "share": round(first / signed, 3) if signed else None,
            "ticket_runs": {"signed_off": len(runs), "first_time": run_first},
            "prs": {"signed_off": pr_signed, "first_time": pr_first}}


def headline(conn: sqlite3.Connection, since: str, until: str, finished: Optional[Iterable[str]] = None,
             unknown_status: Sequence[str] = ()) -> dict:
    """Josh's messages per finished ticket, beside the first-time sign-off share. `finished` is the keys the caller
    has read as Done (Jira); tickets whose newest graph run ended `finished` are added to them."""
    given = set(finished or ())
    by_runs = finished_by_runs(conn)
    done = given | by_runs
    tickets, unattributed = [], 0
    for key, answers, unprompted, sessions in conn.execute(MESSAGES_SQL, _window(since, until)):
        if key is None:
            unattributed += answers + unprompted
        elif key in done:
            tickets.append({"ticket": key, "messages": answers + unprompted, "answers": answers,
                            "unprompted": unprompted, "sessions": sessions})
    tickets.sort(key=lambda t: (-t["messages"], t["ticket"]))
    total = sum(t["messages"] for t in tickets)
    return {"measure": "headline", "since": since, "until": until,
            "josh_messages_per_finished_ticket": {
                "value": round(total / len(tickets), 2) if tickets else None,
                "finished_tickets": len(tickets), "messages": total,
                "answers": sum(t["answers"] for t in tickets), "unprompted": sum(t["unprompted"] for t in tickets)},
            "first_time_signoff": first_time_signoff(conn, since, until),
            "finished_from": {"given": len(given), "graph_runs": len(by_runs)},
            "status_unknown": sorted(unknown_status),
            "unattributed_messages": unattributed,
            "tickets": tickets[:LIST_LIMIT], "truncated": len(tickets) > LIST_LIMIT}


def spend_per_ticket(conn: sqlite3.Connection, since: str, until: str) -> dict:
    """Spend and time per ticket: the cost of the sessions homed to it with an episode in the window (a session's whole
    cost, as the cost ledger prices it), the seconds they worked and waited on Josh, and, of that, what each graph
    step cost."""
    window = _window(since, until)
    sessions: Dict[str, Set[str]] = {}
    for key, uid in conn.execute(SESSION_TICKETS_SQL, window):
        sessions.setdefault(key, set()).add(uid)
    seconds = {uid: (working, waiting) for uid, working, waiting in conn.execute(SESSION_SECONDS_SQL, window)}
    costs = {uid: (cost, status) for uid, cost, status in conn.execute(
        "SELECT session_uid, cost_usd, pricing_status FROM session_cost_totals")}
    steps: Dict[str, List[dict]] = {}
    for key, step, runs, cost in conn.execute(STEP_SPEND_SQL, window):
        steps.setdefault(key, []).append({"step": step, "runs": runs, "cost_usd": cost})
    rows = []
    for key, uids in sessions.items():
        priced = [costs[u] for u in uids if u in costs]
        rows.append({"ticket": key, "sessions": len(uids),
                     "cost_usd": round(sum(c for c, _ in priced or [(0, "")]), 4),
                     "fully_priced": all(s == "priced" for _, s in priced) and len(priced) == len(uids),
                     "seconds_working": sum(seconds.get(u, (0, 0))[0] for u in uids),
                     "seconds_waiting_on_josh": sum(seconds.get(u, (0, 0))[1] for u in uids),
                     "graph_steps": steps.get(key, [])})
    rows.sort(key=lambda r: (-r["cost_usd"], r["ticket"]))
    return {"measure": "spend-and-time-per-ticket", "since": since, "until": until, "tickets": len(rows),
            "cost_usd": round(sum(r["cost_usd"] for r in rows), 4), "rows": rows[:LIST_LIMIT],
            "truncated": len(rows) > LIST_LIMIT}


def instruction_size(conn: sqlite3.Connection, since: str, until: str) -> dict:
    """The size of the instructions a session loads, and the skills, agents and MCP servers loaded in sessions of the
    window that nobody used in any of them."""
    window = _window(since, until)
    sizes = [row[0] for row in conn.execute(INSTRUCTION_SQL, window)]
    unused = [{"kind": kind, "name": name, "episodes_loaded": episodes}
              for kind, name, episodes in conn.execute(UNUSED_SQL, window)]
    return {"measure": "instruction-size", "since": since, "until": until, "episodes": len(sizes),
            "bytes": {"mean": round(statistics.mean(sizes)), "median": round(statistics.median(sizes)),
                      "max": max(sizes)} if sizes else None,
            "loaded_never_used": unused}


def loose_ends() -> dict:
    return {"measure": "loose-ends", "status": "not computed here",
            "reason": "JP-109 computes loose ends from git and tickets; this command reads them once it stores them"}


# -- the command ---------------------------------------------------------------------------------------------------

def _day(text: str, end: bool = False) -> str:
    try:
        moment = time.strptime(text, "%Y-%m-%d")
    except ValueError:
        raise argparse.ArgumentTypeError("{!r} is not a date (YYYY-MM-DD)".format(text))
    stamp = calendar.timegm(moment) + (86400 if end else 0)
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(stamp))


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="measures", description="The ledger's measures. For Josh, not for agents.")
    p.add_argument("measure", choices=["headline", "first-time", "spend", "instructions", "loose-ends", "ticket", "all"])
    p.add_argument("key", nargs="?", help="the ticket key, for `ticket` (for example JP-170)")
    p.add_argument("--json", action="store_true", help="`ticket` prints a table by default; this prints JSON")
    p.add_argument("--since", type=_day)
    p.add_argument("--until", type=lambda t: _day(t, end=True))
    p.add_argument("--finished", help="comma-separated ticket keys already read as Done")
    p.add_argument("--live", action="store_true", help="read each ticket's status from Jira (read-only)")
    return p


def run(conn: sqlite3.Connection, args: argparse.Namespace, now: str,
        fetch: Optional[Callable[[str], Optional[dict]]] = None) -> dict:
    until = args.until or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(_epoch(now) + 1))
    since = args.since or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(_epoch(until) - DEFAULT_DAYS * 86400))
    if since >= until:
        raise ValueError("--since must come before --until")
    finished = {k.strip() for k in (args.finished or "").split(",") if k.strip()}
    unknown: List[str] = []
    if args.live and args.measure in ("headline", "all"):
        keys = {row[0] for row in conn.execute(MESSAGES_SQL, _window(since, until)) if row[0]}
        done, unknown = live_finished(fetch, keys - finished)
        finished |= done
    if args.measure == "ticket":
        return ticket_costs.ticket_report(conn, ticket_costs.check_key(args.key))
    if args.key:
        raise ValueError("only `ticket` takes a ticket key")
    answers = {"headline": lambda: headline(conn, since, until, finished, unknown),
               "first-time": lambda: first_time_signoff(conn, since, until),
               "spend": lambda: spend_per_ticket(conn, since, until),
               "instructions": lambda: instruction_size(conn, since, until),
               "loose-ends": loose_ends}
    if args.measure == "all":
        return {name: answers[name]() for name in ("headline", "spend", "instructions", "loose-ends")}
    return answers[args.measure]()


def _epoch(stamp: str) -> int:
    return calendar.timegm(time.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ"))


def open_read_only(path: Path) -> sqlite3.Connection:
    if not path.is_file():
        raise FileNotFoundError("there is no ledger at {}".format(path))
    conn = sqlite3.connect("file:{}?mode=ro".format(path), uri=True, timeout=5.0)
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def main(argv: Optional[List[str]] = None, out=None, path: Optional[Path] = None,
         fetch: Optional[Callable[[str], Optional[dict]]] = None, now: Optional[str] = None) -> int:
    out = out or sys.stdout
    args = _parser().parse_args(argv)  # argparse exits 2 on bad input
    try:
        conn = open_read_only(path or db.ledger_path())
    except (FileNotFoundError, sqlite3.Error) as e:
        print("measures: {}".format(e), file=sys.stderr)
        return 2
    try:
        if args.live and fetch is None:
            from ledger import jira_read
            fetch = jira_read.make_fetch()
        answer = run(conn, args, now or common.now_utc(), fetch)
        if args.measure == "ticket" and not args.json:
            out.write(ticket_costs.render(answer))
        else:
            out.write(json.dumps(answer, sort_keys=True, indent=2) + "\n")
    except ValueError as e:
        print("measures: {}".format(e), file=sys.stderr)
        return 2
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
