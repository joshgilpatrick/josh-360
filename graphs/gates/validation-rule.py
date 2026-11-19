#!/usr/bin/env python3
"""Gate validation-rule (JP-168): after a merge or a sign-off, does this ticket go to Deployed to be watched, or to Done?

`watch` only when the key is a JP ticket and its Validation section says "Needed: yes" (whatever else is wrong with the
section: the validation graph's own first step asks Josh about one it cannot read, so a ticket is never held back here).
Everything else is `done`. The gate only reads: it moves, flags and comments on nothing. A ticket that cannot be read is
a GateError, so the run stops instead of guessing.

Outcomes: done, watch. Inputs: ticket_key.
"""
import re

from lib import validation_section
from lib.gate_run import GateError, execute, need

JP_KEY = re.compile(r"JP-[1-9][0-9]*")


def run(inputs, deps):
    key = need(inputs, "ticket_key")
    if not JP_KEY.fullmatch(key):
        return "done", None, "{} is not a JP ticket: Deployed is for JP tickets only".format(key[:40])
    ticket = deps.ticket.read(key)
    if ticket is None:
        raise GateError("{} could not be read".format(key))
    if validation_section.needs_watch(ticket.description):
        return "watch", None, "{} needs a watch in production".format(key)
    return "done", None, "{} has nothing to watch".format(key)


if __name__ == "__main__":
    execute(run, ["ticket_key"])
