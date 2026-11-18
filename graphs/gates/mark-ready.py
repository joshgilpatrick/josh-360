#!/usr/bin/env python3
"""Gate 'mark-ready' (JP-103 design, built in JP-122): the only status move in triage. Not Started to Ready.

Inputs: ticket_key, version (the version that was signed off), graph, system, space. Outcomes: moved, changed.
changed: the ticket's version moved after sign-off (an edit landed mid-run), so nothing is written and the run goes
back to read_ticket. moved: it wrote the route record (josh360.route: graph, system, space, version, run, signed_by,
returns, returns_seen, returned_from; never a priority), read it back, moved the ticket to Ready, read that back, and
commented once (spec, "Exact copy"). The record is written BEFORE the move, so a Ready ticket always has its route.
signed_by is the session the ledger shows doing sign_off in this run; a ticket nobody provably signed is not moved.
"""
from lib.gate_run import GateError, execute, need
from lib.triage import copy, port, runs, verdict


def run(inputs, deps):
    key = need(inputs, "ticket_key")
    version = need(inputs, "version")
    graph = need(inputs, "graph")
    system = need(inputs, "system")
    space = need(inputs, "space")
    run_id = deps.environ.get("JOSH360_RUN_ID")
    if not run_id:
        raise GateError("the run id was not given (JOSH360_RUN_ID)")
    snap = port.read_ticket(deps.jira, key, subtasks=False)
    if snap.ticket.status != "Not Started":
        raise GateError("{} is in {}, not Not Started".format(key, snap.ticket.status or "an unknown status"))
    if snap.version != version:
        return "changed", None, "the ticket changed after sign-off: it is checked again"
    signer = deps.signing_session(run_id)
    if not signer:
        raise GateError("no signing session is on record for this run, so the ticket is not moved")
    _, comments = port.read_history(deps.jira, key)
    returns_notes = [c for c in comments if copy.is_return_note(c.get("body"))]
    previous = port.read_route(deps.jira, key)
    answered = runs.josh_answered(run_id, "ask_returned", deps.environ)
    returns = verdict.count_returns(previous, len(returns_notes), answered)
    seen = previous.get("returns_seen") if isinstance(previous, dict) and isinstance(previous.get("returns_seen"), int) else 0
    new = returns_notes[seen:]
    record = {"graph": graph, "system": system, "space": space, "version": version, "run": run_id, "signed_by": signer,
              "returns": returns, "returns_seen": len(returns_notes), "returned_from": new[-1]["id"] if new else ""}
    if not deps.jira.set_property(key, port.ROUTE_PROPERTY, record):
        raise GateError("the route record on {} did not read back from Jira".format(key))
    if not deps.jira.transition(key, "Ready"):
        raise GateError("{} was not confirmed in Ready by Jira".format(key))
    if not deps.jira.comment(key, copy.ready(run_id, signer, graph, system, port.has_run_label(snap.issue))):
        raise GateError("the Ready comment on {} was not confirmed by Jira".format(key))
    return "moved", None, "Ready, routed to {} ({})".format(graph, system)


if __name__ == "__main__":
    execute(run, ["ticket_key", "version", "graph", "system", "space"])
