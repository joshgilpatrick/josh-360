#!/usr/bin/env python3
"""Gate return-to-triage (JP-104 design, shared with JP-103; built in JP-123): hand a ticket back to triage.

Moves the JP ticket to Not Started, sets the flag, and comments the reason in the workflow's shape so triage takes it
again with reason `returned`. It counts nothing: triage counts returns (spec rule 17). A ticket outside JP is left
untouched, because it belongs to colleagues too and this graph never writes there. The reason is a fixed sentence from
read-ticket, or "the work needs code changes" when the researcher ended `needs_code`; no free text from the ticket.

Outcomes: returned. Inputs: ticket_key, reason.
"""
import re

from lib.gate_run import execute, need, say
from lib.nondev_copy import returned

DEFAULT_REASON = "the work needs code changes, see the researcher's last comment"


def run(inputs, deps):
    key = need(inputs, "ticket_key")
    if not re.match(r"^JP-\d+$", key):
        return "returned", None, "not a JP ticket: left unchanged"
    reason = (inputs.get("reason") or "").strip() or DEFAULT_REASON
    deps.ticket.move(key, "Not Started")
    deps.ticket.set_flag(key, True)
    say(deps.ticket, key, returned(reason), once=True)
    return "returned", None, "returned to triage"


if __name__ == "__main__":
    execute(run, ["ticket_key", "reason"])
