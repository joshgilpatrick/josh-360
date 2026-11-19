"""One call of the validation watch (JP-166). The graph runner calls the wait step every five minutes; almost every call
answers "pending" from two small files and does nothing else. Python 3.9, standard library only.

The watch file (`round-<n>.json`) is written once by `start-watch`. The check log beside it is written only here, one
line per look, check and end, and it is the whole record: a second call after a crash reads it and carries on, so no
check is taken twice and no end is written twice. Nothing here moves, flags or comments on a ticket, and nothing here
calls a model.
"""
from __future__ import annotations

import importlib
import json
import os
import re
from datetime import datetime, timedelta
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

from lib.collectors import reading as readings
from lib.gate_run import GateError
from lib.watch import grading, log, tickets, timetable

ROUND_FILE = re.compile(r"^round-(\d+)\.json$")
COLLECTOR_NAME = re.compile(r"^[a-z][a-z0-9-]*$")
LINK_LIMIT = 300
WATCHED = "Deployed"


def next_round(folder: Path) -> Tuple[int, Path]:
    """One more than the number of watch files there, and that file's path."""
    count = len([p for p in folder.glob("round-*.json") if ROUND_FILE.match(p.name)]) if folder.is_dir() else 0
    return count + 1, folder / "round-{}.json".format(count + 1)


def write_plan(path: Path, plan: dict) -> None:
    """The watch file, written to a temporary name and renamed, so a reader never sees half of it."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(plan, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(str(tmp), str(path))


def newest(folder: Path) -> Optional[Path]:
    """The highest-numbered watch file in the folder."""
    if not folder.is_dir():
        return None
    found = [(int(m.group(1)), p) for p in folder.iterdir() for m in [ROUND_FILE.match(p.name)] if m]
    return max(found)[1] if found else None


def ended(watch_file: Path) -> Optional[dict]:
    """The log's `end` line, or None while the watch is still going."""
    return log.last(log.read(log.path_for(watch_file)), "end")


def default_reader(name: str) -> Optional[Callable]:
    """The `read` function of the collector module with this name, or None. A collector is one module in
    `lib/collectors/` (a name's hyphens become underscores) that has `read`, `FIELDS` and `ARGUMENT`."""
    if not isinstance(name, str) or not COLLECTOR_NAME.fullmatch(name) or name == "reading":
        return None
    try:
        module = importlib.import_module("lib.collectors." + name.replace("-", "_"))
    except ImportError:
        return None
    if all(hasattr(module, attr) for attr in ("read", "FIELDS", "ARGUMENT")):
        return module.read
    return None


def _clean(raw) -> dict:
    """A reading as the log keeps it: numbers and short codes only, and a short link, whatever a reader returned."""
    fields = (raw or {}).get("fields") if isinstance(raw, dict) else None
    link = (raw or {}).get("link") if isinstance(raw, dict) else ""
    return {"fields": {str(name): value for name, value in (fields or {}).items() if readings.fits(value, "value")},
            "link": link[:LINK_LIMIT] if isinstance(link, str) else ""}


def _take_reading(criterion: dict, since: str, deps, readers) -> dict:
    name = criterion.get("collector")
    reader = default_reader(name) if readers is None else readers.get(name)
    if reader is None:
        return _clean(None)
    try:
        return _clean(reader(criterion.get("argument", ""), since, deps))
    except Exception:   # a reader that fails is a reading of unknowns, never a failed watch
        return _clean(None)


def _summary(result: str, reason: str, lines: List[dict]) -> str:
    checks = [line for line in lines if line.get("kind") == "check"]
    passed = len([line for line in checks if line.get("result") == "pass"])
    counts = "{} of {} checks passed".format(passed, len(checks))
    if result in ("met", "needs_josh"):
        return "{}; met on check {}".format(counts, grading.met_on(lines))
    if result == "not_met":
        return "{}; not met ({})".format(counts, reason.replace("_", " "))
    if result == "left_deployed":
        return "the ticket left Deployed; {}".format(counts)
    return "ended with no result ({}); {}".format(reason.replace("_", " "), counts)


def _outcome(end: dict, lines: List[dict], plan: dict) -> Tuple[str, dict, str]:
    result = str(end.get("result"))
    tally = end.get("tally")
    return result, {"watch_result": result, "tally": tally if isinstance(tally, list) else grading.tally(plan, lines)}, \
        _summary(result, str(end.get("reason") or ""), lines)


def _finish(path: Path, lines: List[dict], plan: dict, now: datetime, result: str, reason: str) -> Tuple[str, dict, str]:
    end = {"kind": "end", "at": timetable.iso(now), "result": result, "reason": reason, "tally": grading.tally(plan, lines)}
    log.append(path, end)
    lines.append(end)
    return _outcome(end, lines, plan)


def step(watch_file: Path, deps, readers: Optional[Dict[str, Callable]] = None) -> Tuple[str, Optional[dict], str]:
    """One call. Returns `("pending", None, "")` or `(outcome, {"watch_result": outcome, "tally": [...]}, summary)`.
    `readers` maps a collector's name to its `read`; None loads the real collectors."""
    try:
        plan = json.loads(watch_file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise GateError("the watch file {} cannot be read".format(watch_file.name))
    if not isinstance(plan, dict):
        raise GateError("the watch file {} cannot be read".format(watch_file.name))
    path = log.path_for(watch_file)
    lines = log.read(path)
    existing = log.last(lines, "end")
    if existing is not None:
        return _outcome(existing, lines, plan)

    now = deps.now()
    started_at = timetable.parse(plan.get("started_at"))
    if started_at is None:
        raise GateError("the watch file {} has no start time".format(watch_file.name))
    hours = int(plan.get("check_every_hours") or 24)
    give_up_days = int(plan.get("give_up_days") or 1)

    def beginning() -> Optional[datetime]:
        began = timetable.parse(plan.get("begins_at")) or timetable.parse((log.last(lines, "began") or {}).get("at"))
        return began if began is not None and now >= began else None

    def check_due(begins: Optional[datetime]) -> bool:
        if begins is None:
            return False
        taken = [line for line in lines if line.get("kind") == "check"]
        if not taken:
            return now >= timetable.first_check_at(begins, hours)
        previous = timetable.parse(taken[-1].get("at"))
        return previous is None or now >= previous + timedelta(hours=hours)

    begins = beginning()
    previous_look = timetable.parse((log.last(lines, "look") or {}).get("at"))
    look_due = previous_look is None or (now - previous_look).total_seconds() >= timetable.LOOK_SECONDS
    due = check_due(begins)
    gave_up = begins is not None and timetable.gave_up(begins, give_up_days, now)
    if not look_due and not due and not gave_up:
        return "pending", None, ""

    seen = None
    if look_due or due:
        seen = tickets.status(deps.jira, plan.get("ticket_key", ""))
        watching_start = plan.get("starts_kind") == "ticket" and begins is None
        start_state = tickets.state(deps.jira, plan.get("starts_ticket", "")) if watching_start else ""
        look = {"kind": "look", "at": timetable.iso(now), "status": seen or "unknown", "starts_ticket": start_state}
        log.append(path, look)
        lines.append(look)
        if seen is not None and seen != WATCHED:
            return _finish(path, lines, plan, now, "left_deployed", "left")
        if start_state in ("cancelled", "missing"):
            return _finish(path, lines, plan, now, "no_data", "starts_" + start_state)
        if start_state == "done":
            began = {"kind": "began", "at": timetable.iso(now)}
            log.append(path, began)
            lines.append(began)
            begins = now
            due = False
            gave_up = timetable.gave_up(begins, give_up_days, now)

    if begins is None:
        if timetable.never_began(started_at, now):
            return _finish(path, lines, plan, now, "no_data", "never_began")
        return "pending", None, ""

    if due and seen == WATCHED:
        since = timetable.iso(begins)
        measured = [c for c in plan.get("criteria") or [] if not c.get("manual")]
        got = {c["id"]: _take_reading(c, since, deps, readers) for c in measured}
        if plan.get("complete_kind") == "events" and not grading.events_ready(plan, got):
            judged = {c["id"]: "waiting" for c in measured}
            result = "waiting"
        else:
            judged = {c["id"]: grading.judge(c, got[c["id"]]) for c in measured}
            result = grading.check_result(list(judged.values()))
        taken = len([line for line in lines if line.get("kind") == "check"])
        check = {"kind": "check", "at": timetable.iso(now), "n": taken + 1, "result": result,
                 "criteria": {cid: {"result": judged[cid], "fields": got[cid]["fields"], "link": got[cid]["link"]}
                              for cid in judged}}
        log.append(path, check)
        lines.append(check)

    verdict = grading.grade(lines, plan, gave_up)
    if verdict is None:
        return "pending", None, ""
    return _finish(path, lines, plan, now, verdict[0], verdict[1])
