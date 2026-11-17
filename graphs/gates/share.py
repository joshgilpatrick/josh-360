#!/usr/bin/env python3
"""Gate share (JP-104 design, built in JP-123): share the signed-off deliverable with the one recipient the evidence names.

Runs only after Josh's accept_and_share. Refuses when `phi` is true (from the run or the evidence file) or when the
evidence names no recipient. A recipient that is an email address gets an Outlook draft in Josh's own mailbox, never a
sent email: he presses Send. A recipient that is a ticket outside JP gets a comment there. Anything else is refused.
On success the JP ticket gets `Shared | <recipient> | next gate: close`.

Outcomes: shared, refused. Inputs: ticket_key, phi, deliverable_path, evidence_path.
"""
import re
from pathlib import Path

from lib import evidence
from lib.gate_run import GateError, execute, need, say
from lib.nondev_copy import shared, shared_note
from lib.ticket_text import as_bool

EMAIL = re.compile(r"^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$")
OTHER_TICKET = re.compile(r"^(?!JP-)[A-Z][A-Z0-9]+-\d+$")


def run(inputs, deps):
    key = need(inputs, "ticket_key")
    deliverable = need(inputs, "deliverable_path")
    evidence_path = need(inputs, "evidence_path")
    try:
        doc = evidence.load(Path(evidence_path).expanduser())
    except evidence.EvidenceError as exc:
        raise GateError(str(exc))
    if as_bool(inputs.get("phi"), default=True) or evidence.flag(doc, "phi") is True:
        return "refused", None, "patient data: Josh shares this himself"
    recipient = evidence.text_of(doc, "recipient")
    drafted = bool(EMAIL.match(recipient))
    if drafted:
        name = Path(deliverable).name
        deps.draft_email(recipient, "{}: {}".format(key, name), Path(deliverable).expanduser())
    elif OTHER_TICKET.match(recipient):
        say(deps.ticket, recipient, shared_note(key, evidence.text_of(doc, "summary"), deliverable, evidence_path), once=True)
    else:
        return "refused", None, "the evidence names no recipient this gate can share with"
    say(deps.ticket, key, shared(recipient), once=True)
    return "shared", None, "draft made, not sent" if drafted else "commented on the recipient's ticket"


if __name__ == "__main__":
    execute(run, ["ticket_key", "phi", "deliverable_path", "evidence_path"])
