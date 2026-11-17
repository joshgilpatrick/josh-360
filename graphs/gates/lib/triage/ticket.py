"""A ticket as the Ready checklist reads it (JP-122).

Python 3.9, standard library only. The description is read as *marked text* (lib/adf.to_marked): bold labels are
`**Goal:**`, a Gherkin block is a fenced ```` ```gherkin ```` block and a bullet starts with "- ". A section opens only on
a bold label that names a known section and has its colon, at the start of a line outside a code block. A heading, a
plain "Goal:" line, a label with no colon, a table or a panel opens nothing: the section is reported missing, never
guessed at (spec review focus 1). Text from a script that wrote the ticket through lib/adf.ticket_description reads
back the same way.
"""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

from lib import adf
from lib.ticket_text import SECTION_NAMES

_NAMES = "|".join(re.escape(n) for n in sorted(SECTION_NAMES, key=len, reverse=True))
# **Goal:** text, or **Goal**: text. The colon is required; either side of the closing stars will do.
_LABEL = re.compile(r"^\s*(?:[-*]\s+)?\*\*\s*(" + _NAMES + r")\s*(:)?\s*\*\*\s*(:)?\s*(.*)$", re.IGNORECASE)
_CANONICAL = {n.lower(): n for n in SECTION_NAMES}


@dataclass
class Ticket:
    key: str
    type: str
    summary: str = ""
    description: str = ""
    sections: List[Tuple[str, str]] = field(default_factory=list)
    labels: List[str] = field(default_factory=list)
    links: List[str] = field(default_factory=list)
    parent: Optional[str] = None
    flagged: bool = False
    status: str = ""
    creator: Optional[str] = None
    created: str = ""
    subtasks: List["Ticket"] = field(default_factory=list)

    def section(self, name: str) -> Optional[str]:
        """The first section of that name, or None when there is none."""
        for label, text in self.sections:
            if label == name:
                return text
        return None

    def count(self, name: str) -> int:
        return sum(1 for label, _ in self.sections if label == name)

    @property
    def space(self) -> str:
        return self.key.rsplit("-", 1)[0]


def parse_sections(text: str) -> List[Tuple[str, str]]:
    """Every section in the order it appears, a name repeated as often as it appears."""
    found: List[Tuple[str, List[str]]] = []
    in_code = False
    for line in (text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if line.strip().startswith("```"):
            in_code = not in_code
            if found:
                found[-1][1].append(line)
            continue
        match = None if in_code else _LABEL.match(line)
        if match and (match.group(2) or match.group(3)):
            found.append((_CANONICAL[match.group(1).lower()], [match.group(4).strip()]))
        elif found:
            found[-1][1].append(line)
    return [(name, "\n".join(lines).strip()) for name, lines in found]


def _link_keys(links) -> List[str]:
    keys = []
    for link in links or []:
        for side in ("outwardIssue", "inwardIssue"):
            key = (link.get(side) or {}).get("key")
            if key:
                keys.append(key)
    return sorted(keys)


def description_text(raw) -> str:
    """The marked text of a Jira description: an ADF document, a string, or nothing."""
    if isinstance(raw, dict):
        return adf.to_marked(raw).strip("\n")
    return str(raw or "")


def ticket_from_issue(issue: dict, subtasks: Optional[List[Ticket]] = None) -> Ticket:
    """A Ticket from the shared client's `Jira.get` result (which carries the raw fields, so the ADF is read here)."""
    fields = issue.get("fields") or {}
    text = description_text(fields.get("description"))
    return Ticket(key=issue["key"], type=issue.get("issuetype") or "", summary=issue.get("summary") or "",
                  description=text, sections=parse_sections(text), labels=list(issue.get("labels") or []),
                  links=_link_keys(issue.get("links")), parent=issue.get("parent"), flagged=bool(issue.get("flagged")),
                  status=issue.get("status") or "", creator=(fields.get("creator") or {}).get("accountId"),
                  created=issue.get("created") or "", subtasks=list(subtasks or []))


def ticket_version(ticket: Ticket) -> str:
    """A hash of everything triage judged: summary, description, type, labels and links. Any change moves it."""
    parts = [ticket.summary, ticket.description, ticket.type, ",".join(sorted(ticket.labels)),
             ",".join(sorted(ticket.links))]
    return hashlib.sha256("\n\x1f".join(parts).encode("utf-8")).hexdigest()
