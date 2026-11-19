#!/usr/bin/env python3
"""Whether a follow-up that blocks its ticket is out of the way yet (JP-175). Reads Jira; writes only the follow-up file.

Input: GRAPH_INPUT_FOLLOW_UP, the pointer `follow-up:<run id>:<file id>`.
Outcomes: pending (the new ticket is not Done or Cancelled yet, or Jira cannot say), resolved (it is; the follow-up
is marked resolved and the run it held goes on).

The walker runs it on every pass of a run held by a filed, blocking follow-up; it is not a step of any graph.
Unknown is never resolved: a Jira read that fails answers pending.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib import follow_ups  # noqa: E402
from lib.gate_io import fail, finish, read_inputs  # noqa: E402
from lib.jira import Jira  # noqa: E402


def check(ref, jira):
    doc = follow_ups.load(ref)
    if doc is None:
        raise ValueError("no follow-up at {}".format(ref))
    key = doc.get("key")
    if doc.get("state") == "resolved":
        return "resolved", "{} is out of the way".format(key)
    if not key:
        return "pending", "no ticket yet"
    ticket = jira.get(key, ["status"])
    if ticket is None:
        return "pending", "{} could not be read".format(key)
    if follow_ups.is_done_status(ticket.get("status") or "", ticket.get("status_category") or ""):
        follow_ups.update(ref, state="resolved", resolved_status=ticket.get("status"))
        return "resolved", "{} is {}".format(key, ticket.get("status"))
    return "pending", "{} is {}".format(key, ticket.get("status") or "unknown")


if __name__ == "__main__":
    ref = read_inputs(["follow_up"])["follow_up"] or ""
    if follow_ups.parse_ref(ref) is None:
        fail("follow-up-wait: GRAPH_INPUT_FOLLOW_UP is not a follow-up pointer")
    try:
        outcome, summary = check(ref, Jira.from_env())
    except ValueError as err:
        fail("follow-up-wait: {}".format(err))
    finish(outcome, summary=summary)
