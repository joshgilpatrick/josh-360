#!/usr/bin/env python3
"""Gate 'ticket-facts' (JP-103 design, built in JP-122): the facts triage needs about one ticket, read with no model.

Inputs: ticket_key. Outcomes: read.
Outputs: ticket_type, author_kind (own when an allowed account created it, else other), authors (the session ids in
the josh360.authors property), version (a hash of the summary, description, type, labels and links).
Never reads or returns priority or rank (spec rule 8). A half-read ticket stops the gate.
"""
from lib.gate_run import execute, need
from lib.triage import port


def run(inputs, deps):
    key = need(inputs, "ticket_key")
    snap = port.read_ticket(deps.jira, key, subtasks=False)
    kind = port.author_kind(snap.ticket.creator, port.allowed_accounts(deps.jira, deps.environ))
    outputs = {"ticket_type": snap.ticket.type, "author_kind": kind, "authors": snap.authors, "version": snap.version}
    return "read", outputs, "{} is a {} ticket ({})".format(key, kind, snap.ticket.type)


if __name__ == "__main__":
    execute(run, ["ticket_key"])
