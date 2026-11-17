#!/usr/bin/env python3
"""Gate pick-path (JP-104 design, built in JP-123): how heavy a check does this deliverable get? No model.

Short when a precedent answers the ticket or the kind is `misc`; full otherwise. Always full when the ticket already
carries a delivery or a resolution comment, because that means a revision or a reopen by Josh's reply.

Outcomes: short, full. Inputs: ticket_key, kind, precedent, evidence_path.
"""

from lib.gate_run import execute, need

EARLIER = ("Deliverable ready |", "Resolution:")


def run(inputs, deps):
    key = need(inputs, "ticket_key")
    precedent = (inputs.get("precedent") or "none").strip().lower()
    kind = (inputs.get("kind") or "research").strip().lower()
    if precedent == "none" and kind != "misc":
        return "full", None, "no precedent and not a misc ask"
    if any(c.body.lstrip().startswith(EARLIER) for c in deps.ticket.comments(key)):
        return "full", None, "revised or reopened: always the full check"
    return "short", None, "precedent" if precedent != "none" else "misc ask"


if __name__ == "__main__":
    execute(run, ["ticket_key", "kind", "precedent", "evidence_path"])
