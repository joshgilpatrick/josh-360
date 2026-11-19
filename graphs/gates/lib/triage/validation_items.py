"""The Ready items V1 to V7 for a ticket's Validation section (JP-165; spec "The Ready check").

Python 3.9, standard library only. The section is read by `lib.validation_section`, the one parser the graph and the
movers use, so a ticket that passes here is one the validation graph can read. Each problem it reports already has the
four keys of `lib.triage.checklist.failure` (`item`, `where`, `found`, `needed`).

A Research ticket ships a document, an Epic only groups work and a Subtask is a step of its parent: none carries a
Validation section, so none is checked. A section that is missing is V1's to report, not C2's.
"""
from __future__ import annotations

from typing import List

from lib import validation_section
from lib.triage.ticket import Ticket

HAS_SECTION = ("Story", "Task", "Bug")


def check_validation(ticket: Ticket) -> List[dict]:
    """V1 to V7 for one ticket: the problems the parser finds in its first Validation section."""
    if ticket.type not in HAS_SECTION:
        return []
    return validation_section.parse_text(ticket.section("Validation"), key=ticket.key)["problems"]
