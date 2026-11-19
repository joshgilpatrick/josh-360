#!/usr/bin/env python3
"""Gate deployed (JP-167): the validation graph's entry gate. Is this ticket in Deployed and not flagged?

`pass` when the ticket's status is Deployed and it carries no Jira flag; `refuse` with the reason otherwise. A flag is
Josh's off switch (a parked question, or "stop"), so a flagged ticket is never picked up. A read that fails is a
GateError, so the runner tries the start again next pass: unknown is not a reason to start and not a reason to refuse.

Outcomes: pass, refuse. Inputs: ticket_key.
"""
from lib import jira
from lib.gate_run import GateError, execute, need

WATCHED = "Deployed"


def run(inputs, deps):
    key = need(inputs, "ticket_key")
    found = deps.jira.get(key, fields=["status", jira.FLAG_FIELD])
    if found is None:
        raise GateError("{} could not be read from Jira".format(key))
    if found["status"] != WATCHED:
        return "refuse", None, "{} is in {}, not Deployed".format(key, found["status"] or "no status")
    if found["flagged"]:
        return "refuse", None, "{} is flagged: nothing watches it until the flag is cleared".format(key)
    return "pass", None, "{} is in Deployed and not flagged".format(key)


if __name__ == "__main__":
    execute(run, ["ticket_key"])
