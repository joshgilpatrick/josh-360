#!/usr/bin/env python3
"""Files one follow-up a graph step reported (JP-175): starts a ticket-creation run for it through intake.

Input: GRAPH_INPUT_FOLLOW_UP, the pointer `follow-up:<run id>:<file id>` (graphs/gates/lib/follow_ups.py).
Outcomes: submitted (an intake run started; its id is written into the follow-up file), refused (intake would not
start one; the follow-up is marked dropped and the summary says why).

The walker runs this for every new follow-up before it moves its run on; it is not a step of any graph. It reads the
origin ticket from Jira for its space and its epic, then calls `graphs/intake/submit.py` with the pointer only, so
the step's own words never travel as command text. The run is started for the graph runner (runner
`agent-manager`), which advances it like any other. The ticket-creation graph then drafts the ticket, checks for a
duplicate and asks Josh on its one card; its `create-tickets` gate adds the `graph-follow-up` label and the Blocks
link, and `link-source` writes the new key back into the follow-up file.

Jira that cannot be read fails the gate (exit 1), so the walker warns and tries again on its next pass.
"""
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "intake"))

from lib import follow_ups  # noqa: E402
from lib.gate_io import fail, finish, read_inputs  # noqa: E402
from lib.jira import Jira  # noqa: E402
import submit  # noqa: E402

SPACE = re.compile(r"^([A-Z][A-Z0-9]+)-[1-9][0-9]*$")


def file_one(ref, jira, start=submit.start):
    """(outcome, summary). `start` is submit.start; tests hand in their own."""
    doc = follow_ups.load(ref)
    if doc is None:
        raise ValueError("no follow-up at {}".format(ref))
    if doc.get("state") != "new":
        return "submitted", "already {}".format(doc.get("state"))
    origin = doc.get("origin")
    space = parent = None
    if origin:
        found = SPACE.match(str(origin))
        space = found.group(1) if found else None
        ticket = jira.get(origin, ["parent", "issuetype"])
        if ticket is None:
            raise ValueError("the origin ticket {} could not be read".format(origin))
        parent = ticket.get("parent") if ticket.get("issuetype") != "Epic" else origin
    try:
        intake_run = start("session", ref, space, parent, runner="agent-manager")
    except submit.Refused as err:
        follow_ups.update(ref, state="dropped", refused=str(err)[:200])
        return "refused", "intake refused {}: {}".format(doc["id"], str(err)[:160])
    if not follow_ups.update(ref, state="submitted", intake_run=intake_run):
        raise ValueError("the follow-up file did not read back")
    return "submitted", "follow-up {} went to intake run {}".format(doc["id"], intake_run)


if __name__ == "__main__":
    values = read_inputs(["follow_up"])
    ref = values["follow_up"] or ""
    if follow_ups.parse_ref(ref) is None:
        fail("file-follow-ups: GRAPH_INPUT_FOLLOW_UP is not a follow-up pointer")
    try:
        outcome, summary = file_one(ref, Jira.from_env())
    except ValueError as err:
        fail("file-follow-ups: {}".format(err))
    finish(outcome, summary=summary)
