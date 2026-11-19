#!/usr/bin/env python3
"""Gate hold-watch (JP-167): Josh chose stop. Flag the ticket, and say how to start the watch again.

The ticket stays in Deployed with the Jira flag set, so the validation start rule ("Flagged is EMPTY") does not pick it
up again. Clearing the flag starts a fresh watch. Rule 9: it reads the status first; an unreadable status is a
GateError, and a ticket no longer in Deployed is left alone (nothing written) with the step still answering `held`.

Outcomes: held. Inputs: ticket_key.
"""
from lib import validation_copy as copy
from lib.gate_run import GateError, execute, need, say
from lib.watch import tickets

WATCHED = "Deployed"


def run(inputs, deps):
    key = need(inputs, "ticket_key")
    status = tickets.status(deps.jira, key)
    if status is None:
        raise GateError("the status of {} could not be read".format(key))
    if status != WATCHED:
        return "held", None, "the ticket had already left Deployed"
    deps.ticket.set_flag(key, True)
    say(deps.ticket, key, copy.hold(), once=True)
    return "held", None, "flagged; nothing is watching it"


if __name__ == "__main__":
    execute(run, ["ticket_key"])
