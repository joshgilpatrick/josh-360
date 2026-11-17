#!/usr/bin/env python3
"""Gate 'triage-verdict' (JP-103 design, built in JP-122): combine the results into one verdict.

Inputs: ticket_key, author_kind, failures, kept, graph, route_reason (the route step's conflict sentence). Outcomes: ready, revise (an own ticket with gaps), comment (someone else's ticket with gaps),
escalate (an own ticket with gaps that has come back to triage more than twice since Josh last answered),
exhausted (an own ticket that still has gaps after two drafter rounds in this run, plus one for each time Josh chose one more round).
Output: gaps, numbered, script failures first, then a route conflict, then the kept sign-off defects.
The return budget is counted from the ticket itself (the `Returned to triage` notes and the route record's counts), so it
survives between runs; Josh's answer to ask_returned in this run resets it. Someone else's ticket never escalates.
"""
from lib.gate_run import GateError, execute, need
from lib.ticket_text import as_list
from lib.triage import DRAFTER_ROUNDS, copy, port, runs, verdict


def _list(inputs, name):
    try:
        return as_list(inputs.get(name))
    except ValueError:
        raise GateError("the input '{}' is not a JSON list".format(name))


def run(inputs, deps):
    key = need(inputs, "ticket_key")
    kind = need(inputs, "author_kind")
    failures = _list(inputs, "failures")
    kept = _list(inputs, "kept") if inputs.get("kept") is not None else None
    route_record = port.read_route(deps.jira, key)
    _, comments = port.read_history(deps.jira, key)
    total = sum(1 for c in comments if copy.is_return_note(c.get("body")))
    answered = runs.josh_answered(deps.environ.get("JOSH360_RUN_ID"), "ask_returned", deps.environ)
    returns = verdict.count_returns(route_record, total, answered)
    run_id = deps.environ.get("JOSH360_RUN_ID") or ""
    rounds = runs.prior_round_comments(comments, run_id)
    budget = DRAFTER_ROUNDS + runs.answers_count(run_id, "ask_at_limit", "one_more_round", deps.environ)
    try:
        outcome, gaps = verdict.decide(kind, failures, (inputs.get("route_reason") or "").strip(), (inputs.get("graph") or "").strip() or None,
                                       kept, returns, rounds, budget)
    except ValueError as exc:
        raise GateError(str(exc))
    return outcome, {"gaps": gaps}, "{}: {} gap(s), {} return(s)".format(outcome, len(gaps), returns)


if __name__ == "__main__":
    execute(run, ["ticket_key", "author_kind", "failures", "kept", "graph", "route_reason"])
