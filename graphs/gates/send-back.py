#!/usr/bin/env python3
"""Gate 'send-back' (JP-103 design, built in JP-122): tell someone else's ticket's author what it needs. Comment only.

Inputs: ticket_key, gaps (the numbered list from triage-verdict). Outcomes: sent.
Writes one comment (spec, "Exact copy") and nothing else: the description, labels and links are never touched, Josh is
not asked, and the drafter never runs for this ticket. The comment passes the patient-data screen before it is sent. A
run that crashed after posting does not post it twice. The ticket is checked again when its author edits it.
"""
from lib.gate_run import GateError, execute, need, say
from lib.ticket_text import as_list
from lib.triage import copy
from lib.triage.port import CommentPort


def run(inputs, deps):
    key = need(inputs, "ticket_key")
    try:
        gaps = as_list(inputs.get("gaps"))
    except ValueError:
        raise GateError("the gaps are not a JSON list")
    if not gaps:
        raise GateError("there are no gaps to send back")
    run_id = deps.environ.get("JOSH360_RUN_ID") or "unknown"
    posted = say(CommentPort(deps.jira), key, copy.send_back(run_id, gaps), once=True)
    return "sent", None, "{} gap(s) sent as one comment".format(len(gaps)) if posted else "the same comment was already there"


if __name__ == "__main__":
    execute(run, ["ticket_key", "gaps"])
