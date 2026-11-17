#!/usr/bin/env python3
"""Gate 'ready-check' (JP-103 design, built in JP-122): the Ready checklist, run by a script.

Inputs: ticket_key, ticket_type, version. Outcomes: pass, gaps.
Output: failures (a list of item, where, found, needed; graphs/contracts/ready-checklist.md).
The list is lib/triage/checklist.py: C1 to C13 for every type, then B1 and B2 (Bug), S1 (Story), R1 and R2 (Research).
A fact it cannot read (Jira could not say whether a linked ticket exists, the history cannot be read) stops the gate:
unknown is never read as "passes". No patient data in a failure: C13 names the section and the kind only.
"""
from lib.gate_run import GateError, execute, need
from lib.triage import port
from lib.triage.checklist import Context, Unknown, run_checklist


def run(inputs, deps):
    key = need(inputs, "ticket_key")
    snap = port.read_ticket(deps.jira, key, subtasks=True)
    changelog, comments = port.read_history(deps.jira, key)
    registry = deps.registry
    ctx = Context(lookup=registry.lookup, system_names=registry.system_names, key_exists=deps.jira.exists,
                  send_back_after_edit=port.send_back_after_edit(comments, changelog, snap.ticket.created))
    try:
        failures = run_checklist(snap.ticket, ctx)
    except Unknown as exc:
        raise GateError("the checklist could not decide: unknown " + str(exc))
    if failures:
        return "gaps", {"failures": failures}, "{} item(s) failed: {}".format(
            len(failures), ", ".join(sorted({f["item"] for f in failures})))
    return "pass", {"failures": []}, "every checklist item passed"


if __name__ == "__main__":
    execute(run, ["ticket_key", "ticket_type", "version"])
