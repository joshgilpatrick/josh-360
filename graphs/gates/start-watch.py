#!/usr/bin/env python3
"""Gate start-watch (JP-167): write this round's watch file, and say on the ticket what is being watched.

The watch file (`<run>/work/watch/round-<n>.json`, graphs/contracts/validation-plan.md) holds the timetable, the
criteria and the times: `started_at` (now), `begins_at` and `first_check_at` (empty while the Starts line names a ticket
that is not Done yet). A step run again after a crash finds the newest watch file with the same section version, no
`end` line and no `check` line, and reuses it: no second file, and the comment is posted once.

Reads the ticket's status after the file is written. Deployed: the start comment, once. Another known status: nothing is
written to the ticket. An unknown status stops the run (a GateError), so a retry carries on from the same file.

Outcomes: started. Inputs: ticket_key, criteria, starts, check_every_hours, complete_when, give_up_days, fail_after,
section_version. Outputs: watch_file.
"""
from pathlib import Path

from lib import validation_copy as copy, validation_section
from lib.gate_run import GateError, execute, need, say
from lib.ticket_text import as_list
from lib.watch import log, round as watch_round, tickets, timetable
from lib.watch.history import read_plan


def _number(inputs, name):
    try:
        return int(float(need(inputs, name)))
    except ValueError:
        raise GateError("the input '{}' is not a number".format(name))


def _reusable(folder: Path, version: str):
    """The newest watch file when it is this round already (same section, nothing logged but looks), else None."""
    path = watch_round.newest(folder)
    if path is None or read_plan(path).get("section_version") != version:
        return None
    lines = log.read(log.path_for(path))
    if any(line.get("kind") in ("check", "end", "began") for line in lines):
        return None
    return path


def _plan(inputs, key, round_no, now):
    starts = validation_section.read_starts(need(inputs, "starts"))
    complete = validation_section.read_complete_when(need(inputs, "complete_when"))
    if starts is None:
        raise GateError("the Starts line cannot be read")
    if complete is None:
        raise GateError("the Complete when line cannot be read")
    try:
        criteria = as_list(inputs.get("criteria"))
    except ValueError:
        raise GateError("the input 'criteria' is not a list")
    hours = _number(inputs, "check_every_hours")
    try:
        begins = timetable.begins_at(starts[0], starts[1] if starts[0] == "date" else "", now)
    except ValueError:
        raise GateError("the Starts line names a date that does not exist")
    return {
        "ticket_key": key, "round": round_no, "starts": need(inputs, "starts"), "starts_kind": starts[0],
        "starts_date": starts[1] if starts[0] == "date" else "", "starts_ticket": starts[1] if starts[0] == "ticket" else "",
        "check_every_hours": hours, "complete_when": need(inputs, "complete_when"), "complete_kind": complete[0],
        "complete_n": complete[1], "give_up_days": _number(inputs, "give_up_days"),
        "fail_after": _number(inputs, "fail_after"), "criteria": criteria,
        "section_version": need(inputs, "section_version"), "started_at": timetable.iso(now),
        "begins_at": timetable.iso(begins) if begins else "",
        "first_check_at": timetable.iso(timetable.first_check_at(begins, hours)) if begins else "",
    }


def run(inputs, deps):
    key = need(inputs, "ticket_key")
    folder = Path(deps.work_dir) / "watch"
    path = _reusable(folder, need(inputs, "section_version"))
    if path is None:
        round_no, path = watch_round.next_round(folder)
        watch_round.write_plan(path, _plan(inputs, key, round_no, deps.now()))
    plan = read_plan(path)
    status = tickets.status(deps.jira, key)
    if status is None:
        raise GateError("the status of {} could not be read".format(key))
    if status == "Deployed":
        first = plan["first_check_at"]
        when = local_time(first) if first else "one check after {} is Done".format(plan["starts_ticket"])
        say(deps.ticket, key, copy.start(len(plan["criteria"]), plan["check_every_hours"], plan["complete_when"],
                                         plan["give_up_days"], when), once=True)
    return "started", {"watch_file": str(path)}, "round {} written".format(plan["round"])


def local_time(text: str) -> str:
    """A time in the watch file as the machine's own date and time, `2026-11-19 14:05`."""
    return timetable.parse(text).astimezone().strftime("%Y-%m-%d %H:%M")


if __name__ == "__main__":
    execute(run, ["ticket_key", "criteria", "starts", "check_every_hours", "complete_when", "give_up_days",
                  "fail_after", "section_version"])
