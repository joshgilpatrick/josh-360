"""The per-type Ready checklist as data (JP-121 creates it; JP-122's `ready-check` extends it).

Source: conventions/tickets.md, "Required sections". A ticket proposal holds each section under `sections` by key.
Each check is {"section", "label", "kind"}: kind is "text" (a non-empty sentence), "list" (a non-empty list of
bullets) or "gherkin" (a Gherkin scenario: Given, When and Then). A "list_or_empty" section must be present and may
be empty (Decisions already made).

    CHECKLIST[ticket_type] -> list of checks, in the order the ticket shows them
    problems(ticket) -> one line per missing or empty section
"""
from __future__ import annotations

from typing import Dict, List

_COMMON_HEAD = [
    {"section": "goal", "label": "Goal", "kind": "text"},
    {"section": "first_step", "label": "First step", "kind": "text"},
    {"section": "why", "label": "Why", "kind": "text"},
]
_COMMON_TAIL = [
    {"section": "in_scope", "label": "In scope", "kind": "list"},
    {"section": "not_in_scope", "label": "Not in scope", "kind": "list"},
    {"section": "acceptance_criteria", "label": "Acceptance criteria", "kind": "gherkin"},
    {"section": "parent_or_related", "label": "Parent or related", "kind": "text"},
    {"section": "decisions_already_made", "label": "Decisions already made", "kind": "list_or_empty"},
]

CHECKLIST: Dict[str, List[dict]] = {
    "Story": _COMMON_HEAD + _COMMON_TAIL,
    "Task": _COMMON_HEAD + _COMMON_TAIL,
    "Bug": _COMMON_HEAD + [{"section": "current_behaviour", "label": "Current behaviour", "kind": "text"}] + _COMMON_TAIL,
    "Research": _COMMON_HEAD + [
        {"section": "question", "label": "Question", "kind": "text"},
        {"section": "sources", "label": "Sources", "kind": "list"},
        {"section": "deliverable_format", "label": "Deliverable format", "kind": "text"},
    ] + _COMMON_TAIL,
    "Epic": [
        {"section": "goal", "label": "Goal", "kind": "text"},
        {"section": "phases", "label": "Phases", "kind": "list"},
        {"section": "done_when", "label": "Done when", "kind": "text"},
        {"section": "related_work", "label": "Related work", "kind": "list_or_empty"},
        {"section": "branch_strategy", "label": "Branch strategy", "kind": "text"},
    ],
    "Subtask": [
        {"section": "goal", "label": "Goal", "kind": "text"},
        {"section": "done_when", "label": "Done when", "kind": "gherkin"},
    ],
}

# Fields of the ticket itself (not of `sections`) that every work ticket needs.
TICKET_FIELDS = {"repository": "Repository", "where_it_runs": "Where it runs"}


def _gherkin_ok(value) -> bool:
    text = value if isinstance(value, str) else ""
    return all(word in text for word in ("Scenario", "Given", "When", "Then"))


def section_problem(check: dict, value) -> str:
    """"" when the section is complete, else a short phrase."""
    kind = check["kind"]
    if kind == "list_or_empty":
        return "" if isinstance(value, list) else "must be a list (it may be empty)"
    if kind == "list":
        return "" if isinstance(value, list) and any(str(v).strip() for v in value) else "is empty"
    if kind == "gherkin":
        if not (isinstance(value, str) and value.strip()):
            return "is empty"
        return "" if _gherkin_ok(value) else "needs a Gherkin scenario with Given, When and Then"
    return "" if isinstance(value, str) and value.strip() else "is empty"


def problems(ticket: dict) -> List[str]:
    """One line per missing or empty section of this ticket, by its type. An unknown type has no checklist."""
    ref = ticket.get("ref", "?")
    checks = CHECKLIST.get(ticket.get("type"))
    if checks is None:
        return [f"{ref}: type '{ticket.get('type')}' has no checklist"]
    sections = ticket.get("sections") or {}
    found = [f"{ref}: {c['label']} {section_problem(c, sections.get(c['section']))}"
             for c in checks if section_problem(c, sections.get(c["section"]))]
    if ticket.get("type") not in ("Epic", "Subtask"):
        found += [f"{ref}: {label} is empty" for key, label in TICKET_FIELDS.items()
                  if not str(ticket.get(key) or "").strip()]
    return found
