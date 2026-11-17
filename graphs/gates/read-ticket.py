#!/usr/bin/env python3
"""Gate read-ticket (JP-104 design, built in JP-123): can this ticket be worked by the non-development graph?

Workable only when the ticket is a Ready JP ticket whose Question, Sources and Deliverable format are filled and whose
route record (the `josh360.route` property) names this graph. Anything else, and any failed read, is `not_here`, with
the reason as an output so `return-to-triage` can say it. Outputs search_terms (the Question's words plus the system's
registry description) for the earlier-answer lookup, and deliverable_given: false when the Deliverable format carries
the inferred marker, because then Josh did not choose it.

Outcomes: workable, not_here. Inputs: ticket_key, kind, system, phi.
"""
import json
import re

from lib.gate_run import GateError, execute, need
from lib.ticket_text import is_inferred, parse_sections, words

MAX_TERMS = 25
GRAPH = "non-development"


def registry_words(path, system):
    if not system or system == "none":
        return []
    try:
        with open(str(path), encoding="utf-8") as handle:
            systems = json.load(handle).get("systems") or []
    except (OSError, ValueError):
        return []
    for entry in systems:
        if entry.get("name") == system:
            return words(entry.get("description"))
    return []


def run(inputs, deps):
    key = need(inputs, "ticket_key")
    if not re.match(r"^JP-\d+$", key):
        return "not_here", {"reason": "the ticket is not in JP"}, "not a JP ticket"
    try:
        ticket = deps.ticket.read(key)
    except GateError:
        return "not_here", {"reason": "the ticket could not be read"}, "read failed"
    if ticket.status != "Ready":
        return "not_here", {"reason": "the ticket is not Ready"}, "status is not Ready"
    route_graph = (ticket.route or {}).get("graph")
    if route_graph != GRAPH:
        return "not_here", {"reason": "the ticket is not routed to the non-development graph"}, "route is not " + GRAPH
    sections = parse_sections(ticket.description)
    for name in ("Question", "Sources", "Deliverable format"):
        if not sections.get(name, "").strip():
            return "not_here", {"reason": "the {} section is empty or missing".format(name)}, name + " is empty"
    terms = words(sections["Question"])
    for word in registry_words(deps.registry_path, inputs.get("system")):
        if word not in terms:
            terms.append(word)
    outputs = {"search_terms": terms[:MAX_TERMS], "deliverable_given": not is_inferred(sections["Deliverable format"])}
    return "workable", outputs, "workable"


if __name__ == "__main__":
    execute(run, ["ticket_key", "kind", "system", "phi"])
