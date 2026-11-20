#!/usr/bin/env python3
"""Gate close-out (JP-191): a ticket's last step session has finished, so make sure the ticket is in Done.

No graph step names it. The graph runner runs it once when it closes a ticket's last session: the session's step is
finished and the ticket's newest run ended with the ticket in Done (the runner reads that from its own state file,
never from Jira). Only a gate moves a ticket (graphs/CONVENTION.md, rule 2), so the runner asks this script.

By then `close-ticket` or the validation graph has almost always moved the ticket already, so this is a safety net:

- Done: nothing is done (`already-done`).
- Deployed: left alone (`left`). Its validation watch owns the ticket and moves it to Done when the watch completes.
- Cancelled: left alone (`left`); it ended on purpose.
- Anything else: moved to Done through the same ticket port `close-ticket` uses, with one fixed comment (`moved`).

Outcomes: moved, already-done, left. Inputs: ticket_key.
"""
import re

from lib.gate_run import GateError, execute, need, say

LEAVE = ("Deployed", "Cancelled")
COMMENT = ("Closed out by the graph runner: this ticket's last step session finished and its run ended in Done, "
           "so the ticket is moved to Done.")


def run(inputs, deps):
    key = need(inputs, "ticket_key")
    if not re.match(r"^JP-\d+$", key):
        raise GateError("{} is not a JP ticket: this gate closes JP tickets only".format(key))
    status = deps.ticket.read(key).status
    if status == "Done":
        return "already-done", None, "already in Done"
    if status in LEAVE:
        return "left", None, "left in " + status
    say(deps.ticket, key, COMMENT, once=True)
    deps.ticket.move(key, "Done")
    return "moved", None, "moved from {} to Done".format(status)


if __name__ == "__main__":
    execute(run, ["ticket_key"])
