#!/usr/bin/env python3
"""Gate close-ticket (JP-104 design, built in JP-123): record the resolution and move the ticket to Done.

The comment has a fixed shape so the next run's lookup can find it (`Resolution:` ...). When `phi` is true, from the run
or from the evidence file, the question and answer read "withheld: patient data" and only the path is given, whatever
the evidence file's summary holds. The question is the first part of the evidence's `resolution` when it has a " | ",
else the ticket's own Question; the answer is the rest.

Outcomes: closed. Inputs: ticket_key, phi, deliverable_path, evidence_path.
"""
from pathlib import Path

from lib import evidence
from lib.gate_run import GateError, execute, need, say
from lib.nondev_copy import resolution
from lib.ticket_text import as_bool, parse_sections


def run(inputs, deps):
    key = need(inputs, "ticket_key")
    path = Path(need(inputs, "evidence_path")).expanduser()
    try:
        doc = evidence.load(path)
    except evidence.EvidenceError as exc:
        raise GateError(str(exc))
    phi = as_bool(inputs.get("phi"), default=True) or evidence.flag(doc, "phi") is True
    stated = evidence.text_of(doc, "resolution")
    if " | " in stated:
        question, _, answer = stated.partition(" | ")
    else:
        question, answer = parse_sections(deps.ticket.read(key).description).get("Question", ""), stated
    delivered = (inputs.get("deliverable_path") or "").strip() or str((doc.get("deliverables") or [""])[0])
    refs = [row["ref"] for row in evidence.sources(doc)]
    text = resolution(question, answer, refs, delivered, phi)
    say(deps.ticket, key, text, once=True)
    deps.ticket.move(key, "Done")
    return "closed", None, "resolved and moved to Done"


if __name__ == "__main__":
    execute(run, ["ticket_key", "phi", "deliverable_path", "evidence_path"])
