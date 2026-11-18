#!/usr/bin/env python3
"""Entry gate of the development and non-development graphs (JP-103 design, built in JP-122): is this ticket Ready, and
routed to THIS graph?

Inputs: ticket_key. The graph's own name comes from JOSH360_GRAPH, which the walker sets for the entry gate; a test or a
hand run may give GRAPH_INPUT_GRAPH instead. Outcomes: pass, refuse.
Rule (graphs/contracts/route-record.md): the ticket's status is Ready, its route record names this graph, and the
ticket's version is still the one that was signed off. A ticket edited after sign-off is not Ready in fact, so it goes
back to triage. When a run may start is the runner's rule (Ready and labelled `ready-to-run`, JP-117), not this gate's.
"""

from lib.gate_run import GateError, execute, need
from lib.triage import port


def run(inputs, deps):
    key = need(inputs, "ticket_key")
    graph = (deps.environ.get("JOSH360_GRAPH") or deps.environ.get("GRAPH_INPUT_GRAPH") or "").strip()
    if not graph:
        raise GateError("the graph this gate admits for was not named (JOSH360_GRAPH)")
    snap = port.read_ticket(deps.jira, key, subtasks=False)
    if snap.ticket.status != "Ready":
        return "refuse", None, "the ticket is in {}, not Ready".format(snap.ticket.status or "an unknown status")
    record = port.read_route(deps.jira, key)
    if record is None:
        return "refuse", None, "the ticket has no route record: triage has not signed it off"
    if record.get("graph") != graph:
        return "refuse", None, "the ticket is routed to the {} graph, not {}".format(record.get("graph") or "no", graph)
    if record.get("version") != snap.version:
        return "refuse", None, "the ticket was edited after sign-off: it goes back to triage"
    return "pass", None, "Ready and routed to {}".format(graph)


if __name__ == "__main__":
    execute(run, ["ticket_key"])
