"""Every comment the triage graph writes, word for word (spec, "Exact copy"; JP-122). Python 3.9, standard library only.

Each comment is one line in the `result | evidence | next gate` shape, then its detail lines. A test reads the spec and
holds each function to its text, so the two cannot drift.
"""
from __future__ import annotations

from typing import List, Optional

from lib.ticket_text import collapse
from lib.triage import DRAFTER_ROUNDS


def gap_line(gap: dict) -> str:
    """One numbered gap, as the send-back contract shows it."""
    n = gap.get("n", "?")
    if gap.get("quote") is not None:        # a kept sign-off defect
        return '{}. [{}] "{}". {}. Needed: {}.'.format(n, gap["item"], collapse(gap["quote"]), _stop(gap["problem"]),
                                                       _stop(gap["needed"]))
    return "{}. [{}, {}] {}. Needed: {}.".format(n, gap["item"], gap["where"], _stop(gap["found"]), _stop(gap["needed"]))


def _stop(text: str) -> str:
    return collapse(text).rstrip(". ")


def send_back(run: str, gaps: List[dict]) -> str:
    lines = ["Triage: not Ready yet | run {} | next gate: Ready once these are fixed".format(run),
             "Josh's agents check tickets before they work on them. This one needs:"]
    lines += [gap_line(g) for g in gaps]
    lines.append("It will be checked again when the ticket is edited.")
    return "\n".join(lines)


def round_note(n: int, run: str, closed: List[int], sections: List[str]) -> str:
    return ("Triage: revised by the ticket drafter, round {} of {} | run {} | next gate: Ready check\n"
            "Closed: {}. Changed sections: {}.").format(n, DRAFTER_ROUNDS, run, ", ".join(str(c) for c in closed) or "none",
                                                        ", ".join(sections) or "none")


def question(run: str, text: str, recommendation: str, reason: str) -> str:
    q = _stop(text)
    q = q if q.endswith("?") else q + "?"
    return ("Triage: one question for Josh | run {} | next gate: your answer in Needs you\n{}\n"
            "Recommended: {}, because {}.").format(run, q, _stop(recommendation), _stop(reason))


def card(text: str, recommendation: str, reason: str) -> str:
    """The question as the Needs you card shows it (JP-199): the question and the recommendation, no Jira header."""
    q = _stop(text)
    q = q if q.endswith("?") else q + "?"
    return "{}\n\nRecommended: {}, because {}.".format(q, _stop(recommendation), _stop(reason))


def recommended(reason: str) -> str:
    """The description under the recommendation's option on the card (JP-199)."""
    return "Recommended, because {}.".format(_stop(reason))


def ready(run: str, session: str, graph: str, system: str, starts_now: bool) -> str:
    return "Triage: Ready | run {}, signed off by session {} | route: {} ({}) | next gate: {}".format(
        run, session, graph, system, "starts now" if starts_now else "starts when Josh queues it")


def is_triage_comment(body: Optional[str]) -> bool:
    return (body or "").lstrip().startswith("Triage: ")


def is_send_back(body: Optional[str]) -> bool:
    return (body or "").lstrip().startswith("Triage: not Ready yet")


def is_return_note(body: Optional[str]) -> bool:
    """The note `return-to-triage` (JP-123) leaves when another graph hands a ticket back."""
    return (body or "").lstrip().startswith("Returned to triage")
