#!/usr/bin/env python3
"""Entry gate of triage: admits one drafted ticket (JP-103 design, built in JP-122).

Inputs: ticket_key, reason (new, returned or edited; recorded by the walker, the path is the same for each).
Outcomes: pass, refuse.
Rule (spec, "Who may start a run"): the type is Story, Task, Bug or Research; the status is Not Started; no other triage
run is open on it; either an allowed account created it (an own ticket) or an allowed account last set its Agent Status
to Queued (someone else's ticket Josh handed in); and triage's own latest word is not the newest thing on the ticket
(rule 11: its own edit or comment never starts a run). A read that fails is not "fine": the gate stops with the reason.
"""
from lib.gate_run import GateError, execute, need
from lib.triage import TRIAGE_TYPES, copy, port, runs, times


def run(inputs, deps):
    key = need(inputs, "ticket_key")
    snap = port.read_ticket(deps.jira, key, subtasks=False)
    ticket = snap.ticket
    if ticket.type not in TRIAGE_TYPES:
        return "refuse", None, "a {} never enters triage".format(ticket.type or "ticket with no type")
    if ticket.status != "Not Started":
        return "refuse", None, "the ticket is in {}, not Not Started".format(ticket.status or "an unknown status")
    other = runs.other_open_run(key, deps.environ)
    if other is None:
        raise GateError("the run folders could not be read, so an open run cannot be ruled out")
    if other:
        return "refuse", None, "another triage run on this ticket has not ended"
    changelog, comments = port.read_history(deps.jira, key)
    allowed = port.allowed_accounts(deps.jira, deps.environ)
    if port.author_kind(ticket.creator, allowed) == "other" and port.queued_by(changelog) not in allowed:
        return "refuse", None, "nobody queued this ticket: it was not created by an allowed account and no allowed " \
                               "account set its Agent Status to Queued"
    newest = comments[-1] if comments else None
    if newest and copy.is_triage_comment(newest.get("body")) and times.later(
            newest.get("created"), port.last_description_edit(changelog, ticket.created)):
        return "refuse", None, "triage's own comment is the newest change; nothing has changed since"
    return "pass", None, "admitted"


if __name__ == "__main__":
    execute(run, ["ticket_key", "reason"])
