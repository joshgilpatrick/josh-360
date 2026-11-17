#!/usr/bin/env python3
"""Gate 'route' (JP-103 design, built in JP-122): pick exactly one graph for a ticket that passed the checklist.

Inputs: ticket_key, ticket_type. Outcomes: development, non_development, conflict.
Outputs: graph (development or non-development, as the route record spells it; empty on a conflict), system (the
registry system, or none), space (the registry's Jira space for it, else the ticket's own space), route_reason (the conflict,
in a fixed sentence). Type and Repository decide; the work kind from action-triage.spec only cross-checks `code`.
Never reads or returns priority, rank or area (spec rule 8).
"""
from lib.gate_run import execute, need
from lib.triage import port, route
from lib.triage.checklist import repository_of


def run(inputs, deps):
    key = need(inputs, "ticket_key")
    snap = port.read_ticket(deps.jira, key, subtasks=False)
    repository = repository_of(snap.ticket) or "none"
    found, reason = route.decide_route(snap.ticket.type, repository, port.read_work_kind(deps.jira, key))
    if found == route.CONFLICT:
        return "conflict", {"graph": "", "system": "", "space": "", "route_reason": reason}, reason
    home = None if repository.lower() == "none" else deps.registry.lookup(repository)
    outputs = {"graph": route.GRAPH_NAMES[found], "system": home["system"] if home else "none",
               "space": (home or {}).get("space") or snap.ticket.space, "route_reason": ""}
    return found, outputs, "routes to the {} graph".format(outputs["graph"])


if __name__ == "__main__":
    execute(run, ["ticket_key", "ticket_type"])
