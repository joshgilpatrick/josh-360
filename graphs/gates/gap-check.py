#!/usr/bin/env python3
"""Gate gap-check (JP-104 design, built in JP-123): is there a reason to ask Josh before any work starts?

Fires only on signals a script can see, never on a model's confidence: no precedent was found AND the ticket's
Deliverable format was inferred, not given by Josh. Then `gap` holds the one-sentence question (spec, "Exact copy"), and
`card` the same text, which the walker shows on the ask.

Outcomes: clear, gap. Inputs: ticket_key, kind, deliverable_given, precedent.
"""

from lib.gate_run import execute, need
from lib.nondev_copy import ping_before
from lib.ticket_text import as_bool, parse_sections, shorten, strip_marker


def run(inputs, deps):
    key = need(inputs, "ticket_key")
    precedent = (inputs.get("precedent") or "none").strip().lower()
    if precedent != "none" or as_bool(inputs.get("deliverable_given"), default=True):
        return "clear", None, "no gap"
    sections = parse_sections(deps.ticket.read(key).description)
    kind = (inputs.get("kind") or "research").strip()
    text = ping_before(
        key,
        shorten(sections.get("Question", ""), 240),
        shorten(strip_marker(sections.get("Deliverable format", "")), 160) or "the format I think fits",
        "that format fits, since the ticket did not give one (I worked it out from the kind of work: {})".format(kind))
    return "gap", {"gap": text, "card": text}, "gap: no precedent and the deliverable was inferred"


if __name__ == "__main__":
    execute(run, ["ticket_key", "kind", "deliverable_given", "precedent"])
