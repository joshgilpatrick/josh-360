"""Where a ticket is in its graphs: `runner.py where <KEY>` and the published report's `tickets` list (JP-172).

Python 3.9, standard library only. Read-only: it reads the ledger (`graph_runs`, `step_runs`, `step_results`,
`run_ends`), the run folders, the session files, the graph headers and the refusals file, and writes nothing.

One answer per run on the ticket, newest first: its graph, the step it is at (or ended at) and that step's Jira status
from the graph's `header.jira`, its state, the attempt, what it waits on, and every step session with its attempt, tier
and model. `where` adds each step's cost and the total (cost is for the laptop: Josh and his leads); the published
`tickets` rows never carry cost, and carry no text from a run either: a stopped run says whether it hit the cap, not the
error it stopped on. A run that ended or stopped with the ticket's worktree still on disk says "Worktree kept" with its
path and branch, in both (JP-174). The one piece of walker text that is published is a refusal reason, cut to 200 characters.
"""
from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path
from typing import Dict, List, Optional

from . import ledgerview, paths, refusals, status
from ledger import ticket_costs  # noqa: E402

# What a run waiting on a wait step is waiting for, by the wait's script. Anything else is "the <script> check".
WAIT_WORDS = {"review-state": "a review", "pr-merged": "the pull request to merge",
              "watch-criteria": "the validation watch", "fix-closed": "the fix ticket to close"}
CAP_WORDS = "as often as its tier allows"
SESSION_KEYS = ("step", "attempt", "loop_count", "tier", "model", "session", "am_session", "outcome", "reason",
                "started_at", "ended_at", "failure_kind", "earlier_am_sessions")
COUNTS_KEY = "ticket_counts"


def label(step: Optional[str]) -> Optional[str]:
    """A step id as a person reads it: `build` is Build, `ask_josh` is Ask josh."""
    return step.replace("_", " ").capitalize() if step else None


def _waits_on(state: str, step: Optional[str], since: Optional[str], graph, stop_reason,
              on: Optional[str] = None, stop_kind: Optional[dict] = None) -> Optional[dict]:
    if state == "parked":
        return {"kind": "question", "text": "a question to Josh", "since": since}
    if state == "waiting" and on:                 # a follow-up that blocks the ticket (JP-175): its key, or its id
        return {"kind": "follow-up", "text": on if on.startswith("follow-up") else "follow-up {}".format(on), "since": since}
    if state == "waiting":
        script = (graph.steps.get(step) or {}).get("wait") if graph is not None and step else None
        text = WAIT_WORDS.get(script) or ("the {} check".format(script) if script else "a check")
        return {"kind": "check", "text": text, "since": since}
    if state == "stopped":
        kind, code = (stop_kind or {}).get("kind"), (stop_kind or {}).get("code")
        if kind == "needs-fix":                     # JP-183: fixed words and a reason code only, never the message
            return {"kind": "fix", "text": "Josh: it needs a fix ({}); the run goes on by itself once the fix reaches the "
                    "laptop".format(code), "since": since}
        if kind == "may-clear":
            return {"kind": "stuck", "text": "Josh: it is stuck ({}); resume it once that clears".format(code),
                    "since": since}
        if CAP_WORDS in str(stop_reason or ""):
            return {"kind": "cap", "text": "Josh: the step ran as often as its tier allows (allow or retry it)",
                    "since": since}
        return {"kind": "stop", "text": "Josh: the run stopped (retry it once the cause is fixed)", "since": since}
    if state == "queued":
        return {"kind": "session", "text": "a free session slot", "since": since}
    return None


def _stop_reason(run_id: str) -> Optional[str]:
    try:
        from walker_lib import runfolder  # noqa: E402  (graphs/tools, on the path through paths)
        stopped = runfolder.load(run_id).get("stopped") or {}
    except (FileNotFoundError, ValueError, OSError):
        return None
    return " ".join(str(stopped.get("reason") or "").split())[:200] or None


def _tilde(path: str) -> str:
    home = os.path.expanduser("~")
    return "~" + path[len(home):] if home and (path == home or path.startswith(home + os.sep)) else path


def worktree_kept(run_id: str, state: str) -> Optional[dict]:
    """The ticket's worktree and branch when a run that ended or stopped left the worktree on disk (JP-174), else None.
    Both come from `prepare-worktree`'s outputs in run.json; the path is shown with `~` for the home folder."""
    if state not in ("ended", "stopped"):
        return None
    try:
        from walker_lib import runfolder  # noqa: E402  (graphs/tools, on the path through paths)
        values = runfolder.values(runfolder.load(run_id))
    except (FileNotFoundError, ValueError, OSError):
        return None
    tree, branch = values.get("worktree"), values.get("branch")
    if not isinstance(tree, str) or not tree or not os.path.isdir(os.path.expanduser(tree)):
        return None
    return {"path": _tilde(tree), "branch": branch if isinstance(branch, str) else None}


def run_entry(conn: sqlite3.Connection, run: dict, now: float, root: Optional[Path] = None,
              with_cost: bool = False) -> dict:
    """One run's answer. `run` is a `ledgerview.ticket_runs` row."""
    report = status.run_report(conn, run["run"], root, with_cost=with_cost)
    steps = report["steps"]
    if run.get("end"):
        named = [s["step"] for s in steps if not str(s["step"]).startswith("_")]   # not the entry and exit gates
        state, step, since, on = "ended", (named[-1] if named else None), run.get("ended_at"), None
    else:
        row = status.run_row(conn, run)
        state, step, since, on = row["state"], row["step"], row["since"], row.get("waiting_on")
    graph = status._graph(run["graph"], root)
    jira = graph.stretch_status(step) if graph is not None and step in graph.steps else None
    attempts = [s["attempt"] for s in steps if s["step"] == step]
    stop_reason = _stop_reason(run["run"]) if state == "stopped" else None
    entry = {"run": run["run"], "graph": run["graph"], "ticket": run["ticket"], "runner": run.get("runner"),
             "started_at": run["started_at"], "step": step, "step_label": label(step), "jira_status": jira,
             "state": state, "since": since, "attempt": max(attempts) if attempts else None,
             "end": run.get("end"), "score": run.get("score"),
             "waits_on": _waits_on(state, step, since, graph, stop_reason, on,
                                   status._stop_kind(run["run"]) if state == "stopped" else None),
             "worktree_kept": worktree_kept(run["run"], state),
             "sessions": [dict({k: s.get(k) for k in SESSION_KEYS}, kind=s["kind"]) for s in steps]}
    if with_cost:
        for out, s in zip(entry["sessions"], steps):
            out.update(cost_usd=s.get("cost_usd"), cost_pricing=s.get("cost_pricing"))
        entry["stop_reason"] = stop_reason
        entry.update(_total(entry["sessions"]))
    return entry


def _total(rows: List[dict]) -> dict:
    """The cost of these step rows, each session counted once (a session that did several steps shows its whole cost
    on each of its rows, as the run report does), and how many of those sessions are not fully priced yet."""
    seen: Dict[object, dict] = {}
    for r in rows:
        if r.get("cost_pricing"):
            seen.setdefault(r.get("session") or (r.get("step"), r.get("attempt"), r.get("loop_count")), r)
    total = round(sum(r["cost_usd"] or 0.0 for r in seen.values()), 4)
    unpriced = sum(1 for r in seen.values() if r["cost_pricing"] != "priced")
    priced_any = any(r["cost_usd"] is not None for r in seen.values())
    return {"cost_usd": total if priced_any else None, "cost_not_fully_priced": unpriced}


def where(conn: sqlite3.Connection, ticket: str, now: float, root: Optional[Path] = None) -> dict:
    """Every run on the ticket, newest first, with cost (the laptop's answer)."""
    ticket = ticket_costs.check_key(ticket)
    runs = [run_entry(conn, r, now, root, with_cost=True) for r in ledgerview.ticket_runs(conn, ticket)]
    refused = refusals.current(now, ticket)
    answer = {"ticket": ticket, "runs": runs, "refused": refused if refused is not None else "unreadable", "with_cost": True}
    answer.update(_total([s for r in runs for s in r["sessions"]]))
    return answer


def ticket_rows(conn: sqlite3.Connection, now: float, open_rows: List[dict], ended: List[dict],
                root: Optional[Path] = None) -> dict:
    """The published report's `tickets` list and `ticket_counts`: one row per ticket with an open run, a run that
    ended within `ended_runs_days`, or a refusal seen in that time. The row is the ticket's newest such run; no cost."""
    newest: Dict[str, dict] = {}
    counts: Dict[str, int] = {}
    for run in sorted(open_rows + ended, key=lambda r: str(r.get("started_at") or ""), reverse=True):
        key = run.get("ticket")
        if not key:
            continue
        counts[key] = counts.get(key, 0) + 1
        newest.setdefault(key, run)
    found = refusals.current(now)
    by_ticket: Dict[str, List[dict]] = {}
    for item in found or []:
        by_ticket.setdefault(item["ticket"], []).append({k: item[k] for k in ("graph", "reason", "first_at", "last_at")})
    rows = []
    for key in sorted(set(newest) | set(by_ticket)):
        run = newest.get(key)
        row = run_entry(conn, dict(run, runner=status.RUNNER), now, root) if run else {"ticket": key, "run": None,
                                                                                    "state": "not started"}
        row.update(runs=counts.get(key, 0), refused=by_ticket.get(key, []))
        rows.append(row)
    tally = {"listed": len(rows), "refused": sum(1 for r in rows if r["refused"]),
             "refusals_readable": found is not None}
    return {"tickets": rows, COUNTS_KEY: tally}


def cost_fields(doc: object, skip_counts: bool = True) -> int:
    """How many keys anywhere in `doc` name a cost. The counter itself (`ticket_counts.cost_fields`) is not counted."""
    count = 0
    if isinstance(doc, dict):
        for key, value in doc.items():
            if skip_counts and key == COUNTS_KEY and isinstance(value, dict):
                count += cost_fields({k: v for k, v in value.items() if k != "cost_fields"}, False)
                continue
            count += ("cost" in str(key).lower()) + cost_fields(value, skip_counts)
    elif isinstance(doc, list):
        count += sum(cost_fields(item, skip_counts) for item in doc)
    return count


def from_snapshot(snap: dict, ticket: str) -> dict:
    """The same answer from a published report's `tickets` row (how a lead reads it in the cloud): the newest run only,
    and no cost."""
    ticket = ticket_costs.check_key(ticket)
    for row in snap.get("tickets") or []:
        if row.get("ticket") == ticket:
            runs = [] if row.get("run") is None else [{k: v for k, v in row.items() if k not in ("refused", "runs")}]
            return {"ticket": ticket, "runs": runs, "refused": row.get("refused") or [], "with_cost": False,
                    "runs_on_laptop": row.get("runs", 0)}
    return {"ticket": ticket, "runs": [], "refused": [], "with_cost": False, "runs_on_laptop": 0}


def _money(value: Optional[float], unpriced: int) -> str:
    if value is None:
        return "not priced yet" if unpriced else "nothing yet (no step session has a cost recorded)"
    return "${:.2f}".format(value) + (" ({} session(s) not fully priced yet)".format(unpriced) if unpriced else "")


def render(answer: dict) -> str:
    key = answer["ticket"]
    refused = answer.get("refused")
    if not answer["runs"] and not refused:
        if answer.get("refused") == "unreadable":
            return "No graph has run on {}. (The refusals file could not be read.)\n".format(key)
        return "No graph has run on {}.\n".format(key)
    lines = ["# {}".format(key), ""]
    if not answer.get("with_cost") and answer.get("runs_on_laptop", 0) > 1:
        lines += ["The published report shows the newest of {} runs; `where` on the laptop lists them all.".format(
            answer["runs_on_laptop"]), ""]
    for run in answer["runs"]:
        lines.append("## {} run {}".format(run["graph"], run["run"]))
        lines.append("")
        if run["state"] == "ended":
            lines.append("Ended {} ({}) at {}, Jira status {}.".format(run.get("end"), run.get("score"),
                                                                       run.get("step_label") or "-", run.get("jira_status") or "-"))
        elif not run.get("step"):
            lines.append("Between steps since {}: the next advance picks the next step.".format(run.get("since") or "-"))
        else:
            lines.append("At {} (`{}`), attempt {}, Jira status {}: {} since {}.".format(
                run.get("step_label") or "-", run.get("step") or "-", run.get("attempt") or "-",
                run.get("jira_status") or "-", run["state"], run.get("since") or "-"))
        waits = run.get("waits_on")
        if waits:
            lines.append("Waiting on {}, since {}.".format(waits["text"], waits.get("since") or "-"))
        kept = run.get("worktree_kept")
        if kept:
            lines.append("Worktree kept: `{}` on branch `{}`. Nothing removes it on its own: `/closeout` lists it, and "
                         "Josh decides.".format(kept["path"], kept.get("branch") or "-"))
        if run.get("stop_reason"):
            lines.append("Stopped because: {}".format(run["stop_reason"]))
        lines += ["", "| Step | Attempt | Tier | Model | Session | Agent Manager session | Outcome | Cost |",
                  "| --- | --- | --- | --- | --- | --- | --- | --- |"]
        for s in run["sessions"]:
            cost = "-"
            if answer.get("with_cost") and s.get("cost_pricing"):
                cost = ticket_costs.cost_text(s.get("cost_usd"), s["cost_pricing"])
            cells = [s["step"], s.get("attempt"), s.get("tier"), s.get("model"), s.get("session"), s.get("am_session"),
                     s.get("outcome") or ("(" + s["reason"] + ")" if s.get("reason") else "open"), cost]
            lines.append("| " + " | ".join("" if c is None else str(c).replace("|", "/") for c in cells) + " |")
        if answer.get("with_cost"):
            lines += ["", "Cost of this run: {}".format(_money(run.get("cost_usd"), run.get("cost_not_fully_priced") or 0))]
        lines.append("")
    if answer.get("with_cost") and answer["runs"]:
        lines.append("Total cost on {}: {} (each session counted once)".format(
            key, _money(answer.get("cost_usd"), answer.get("cost_not_fully_priced") or 0)))
    elif answer["runs"]:
        lines.append("Cost is not in a published report; run `where {}` on the laptop to see it.".format(key))
    if refused == "unreadable":
        lines.append("The refusals file could not be read.")
    for item in refused if isinstance(refused, list) else []:
        lines.append("Refused: {} would not start, last seen {}: {}".format(item["graph"], item["last_at"], item["reason"]))
    return "\n".join(lines).rstrip("\n") + "\n"


def dumps(answer: dict) -> str:
    return json.dumps(answer, sort_keys=True)
