#!/usr/bin/env python3
"""Gate close-watch (JP-167): say why a watched ticket is done, and move it to Done. Serves three steps.

`result` tells them apart: `met` posts the "Validated in production" comment and the evidence table (the check number
and round from the newest watch file and its log); `not_needed` posts "Nothing to watch" with the reason; anything else
is Josh's accept and posts "Closed on Josh's answer" quoting the first line of the card, and the table when there is one.
Each comment is posted with `once`, then the ticket moves to the step's target status and the status is read back.

Rule 9: it reads the ticket's status first. A status it cannot read is a GateError. A ticket no longer in Deployed is
left alone, with nothing written, and the step still answers `closed`.

Outcomes: closed. Inputs: ticket_key, result, evidence, target_status.
"""
from pathlib import Path

from lib import validation_copy as copy
from lib.gate_run import GateError, execute, need, say
from lib.watch import grading, history, log, round as watch_round, tickets

WATCHED = "Deployed"


def _with_table(headline, table):
    return headline + ("\n" + table.strip() if table and table.strip() else "")


def _met(deps, table):
    path = watch_round.newest(Path(deps.work_dir) / "watch")
    if path is None:
        raise GateError("there is no watch file to say which check met the criteria")
    plan = history.read_plan(path)
    check = grading.met_on(log.read(log.path_for(path)))
    return _with_table(copy.met(str(plan.get("complete_when") or ""), check, int(plan.get("round") or 1)), table)


def _accepted(deps, table):
    try:
        card = (Path(deps.work_dir) / "watch" / "card.md").read_text(encoding="utf-8")
    except OSError:
        card = ""
    line = " ".join((card.splitlines() or [""])[0].split()) or "no reason was recorded"
    date = deps.now().astimezone().strftime("%Y-%m-%d")
    return _with_table(copy.accepted(date, line), table)


def run(inputs, deps):
    key, target = need(inputs, "ticket_key"), need(inputs, "target_status")
    status = tickets.status(deps.jira, key)
    if status is None:
        raise GateError("the status of {} could not be read".format(key))
    if status != WATCHED:
        return "closed", None, "the ticket had already left Deployed"
    result = (inputs.get("result") or "").strip()
    table = inputs.get("evidence") or ""
    if result == "met":
        text = _met(deps, table)
    elif result == "not_needed":
        text = copy.unwatched(table.strip())
    else:
        text = _accepted(deps, table)
    say(deps.ticket, key, text, once=True)
    deps.ticket.move(key, target)
    if tickets.status(deps.jira, key) != target:
        raise GateError("{} was not confirmed at {} by Jira".format(key, target))
    return "closed", None, "moved to " + target


if __name__ == "__main__":
    execute(run, ["ticket_key", "result", "evidence", "target_status"])
