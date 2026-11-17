"""Combining the results into one verdict, and the return budget (JP-122; spec, "Sending a ticket back" and "How every
loop ends"). Python 3.9, standard library only.
"""
from __future__ import annotations

from typing import List, Optional, Tuple

from lib.triage import DRAFTER_ROUNDS, RETURN_BUDGET


def number_gaps(failures: List[dict], route_reason: str, kept: Optional[List[dict]]) -> List[dict]:
    """The numbered gaps: script failures first, then a route conflict, then the kept sign-off defects (the send-back
    contract). Each keeps its own fields and gains `n`."""
    gaps: List[dict] = []
    for failure in failures or []:
        gaps.append(dict(failure))
    if route_reason:
        gaps.append({"item": "ROUTE", "where": "ticket", "found": route_reason,
                     "needed": "Make the type and the Repository agree: a repository for a Bug, a Story or code work."})
    for defect in kept or []:
        gaps.append(dict(defect))
    for n, gap in enumerate(gaps, start=1):
        gap["n"] = n
    return gaps


def decide(author_kind: str, failures: List[dict], route_reason: str, graph: Optional[str],
           kept: Optional[List[dict]], returns: int, rounds: int = 0, round_budget: int = DRAFTER_ROUNDS
           ) -> Tuple[str, List[dict]]:
    """(outcome, gaps). Outcomes: ready, revise (an own ticket with gaps), comment (someone else's ticket with gaps),
    escalate (an own ticket with gaps that has now come back more than RETURN_BUDGET times), exhausted (an own ticket
    that still has gaps after `round_budget` drafter rounds in this run: Josh is asked, the drafter does not run again).

    Ready needs everything: no failures, a route, and a sign-off that ran and kept no defect. A sign-off that did not
    run (kept is None) with nothing else wrong means the graph is broken, so this raises instead of passing."""
    gaps = number_gaps(failures, route_reason, kept)
    if not gaps:
        if not graph or kept is None:
            raise ValueError("no gaps but no route or no sign-off: the graph skipped a step")
        return "ready", []
    if author_kind != "own":
        return "comment", gaps        # someone else's ticket never escalates and never runs the drafter
    if returns > RETURN_BUDGET:
        return "escalate", gaps
    if rounds >= round_budget:
        return "exhausted", gaps
    return "revise", gaps


def count_returns(record: Optional[dict], return_comments: int, josh_answered: bool) -> int:
    """How many times the ticket has come back to triage since Josh last answered about it.

    The route record keeps `returns` (counted at the last Ready) and `returns_seen` (return notes on the ticket at
    that time); every return note since is a new return. Josh's answer to `ask_returned` in this run resets the count,
    because it is new information (spec rule 10)."""
    if josh_answered:
        return 0
    record = record if isinstance(record, dict) else {}
    seen = record.get("returns_seen")
    seen = seen if isinstance(seen, int) and not isinstance(seen, bool) else 0
    base = record.get("returns")
    base = base if isinstance(base, int) and not isinstance(base, bool) else 0
    return base + max(0, return_comments - seen)
