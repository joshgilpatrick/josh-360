"""The exact copy the non-development gates write (docs/design/non-development-graph.md, "Exact copy"; JP-123).

Python 3.9, standard library only. One function per piece of copy, so a test can hold each to the spec word for word.
When the run's `phi` is true the words that could carry patient data read "withheld: patient data" and only paths
are given.
"""
from __future__ import annotations

from typing import List, Optional

from lib.ticket_text import collapse, shorten

WITHHELD = "withheld: patient data"
SUMMARY_WITHHELD = "summary withheld: patient data"
NO_SUMMARY = "summary not given"
MAX_SOURCES = 10


def _sentence(text: str) -> str:
    """The text ending in one full stop, or in the question or exclamation mark it already has."""
    text = text.strip().rstrip(". ")
    return text if text.endswith(("?", "!")) else text + "."


def ping_before(key: str, question: str, deliverable: str, assumption: str) -> str:
    return ('{}: before I start. Question: {} I\'ll deliver {}, assuming {}. Is that right? '
            'One sentence is enough, or reply "go".').format(key, _sentence(question), deliverable.rstrip(". "),
                                                              assumption.rstrip(". "))


def deliver_comment(summary: Optional[str], deliverable: str, evidence: str, phi: bool) -> str:
    said = SUMMARY_WITHHELD if phi else (shorten(summary or "", 600) or NO_SUMMARY)
    return "Deliverable ready | {} · {} · evidence {} | next gate: Josh's sign-off".format(said, deliverable, evidence)


def email_body(key: str, summary: Optional[str], deliverable: str, evidence: str, phi: bool) -> str:
    said = SUMMARY_WITHHELD if phi else (shorten(summary or "", 600) or NO_SUMMARY)
    return "{}: {}\n\nDeliverable: {}\nEvidence: {}\n".format(key, said, deliverable, evidence)


def resolution(question: str, answer: str, refs: List[str], deliverable: str, phi: bool) -> str:
    q = WITHHELD if phi else (shorten(question, 300) or "(no question given)")
    a = WITHHELD if phi else (shorten(answer, 400) or "(no answer given)")
    shown = [collapse(r) for r in refs[:MAX_SOURCES]]
    return "Resolution: {} | {} | sources: {} | deliverable: {} | next gate: none".format(
        q, a, ", ".join(shown) if shown else "none", deliverable)


def returned(reason: str) -> str:
    return "Returned to triage | {} | next gate: triage".format(collapse(reason))


def shared(recipient: str) -> str:
    return "Shared | {} | next gate: close".format(collapse(recipient))


def shared_note(key: str, summary: Optional[str], deliverable: str, evidence: str) -> str:
    """The comment on a ticket outside JP, when the evidence names one as the recipient."""
    return "{} deliverable ready | {} · {} · evidence {} | next gate: the ticket's owner".format(
        key, shorten(summary or "", 600) or NO_SUMMARY, deliverable, evidence)
