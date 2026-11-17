"""Reads and checks the two ticket creation contracts: the intake record and the ticket proposal (JP-121).

Both are JSON files (graphs/contracts/intake-record.md, ticket-proposal.md): the gates run on the laptop's Python 3.9
with no YAML reader. A gate input holds a path to the file, or the JSON itself.

    load_json(value)            the object behind a path or inline JSON; raises ContractError
    load_record(value)          the intake record, checked
    load_proposal(value)        the ticket proposal, checked (ticket creation: create or comment_on_match)
    load_revision(value)        a drafter's revision of one existing ticket (triage, JP-122), checked
    load_question(value)        the one question a drafter returns with needs_josh, checked
    record_problems(record)     [] or one line per problem
    proposal_problems(p)        [] or one line per problem
    value_of(field)             a field that is text or {"value": ..., "basis": ...}, as its value
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, List

TICKET_TYPES = ("Story", "Task", "Bug", "Research", "Epic")
WORK_KINDS = ("code", "doc", "research", "email", "meeting", "misc")
SHAPES = ("single", "parent_with_subtasks", "epic_with_tickets")
ACTIONS = ("create", "comment_on_match")


class ContractError(Exception):
    """A contract file that cannot be read or is not JSON. The message names the problem, never file content."""


def load_json(value: Any) -> Any:
    if value is None or (isinstance(value, str) and not value.strip()):
        raise ContractError("no value given")
    if not isinstance(value, str):
        return value
    text = value.strip()
    if text[0] in "{[":
        try:
            return json.loads(text)
        except ValueError as err:
            raise ContractError(f"not valid JSON ({err})") from err
    try:
        return json.loads(Path(text).read_text(encoding="utf-8"))
    except OSError as err:
        raise ContractError(f"cannot read {Path(text).name} ({err.strerror or err})") from err
    except ValueError as err:
        raise ContractError(f"{Path(text).name} is not valid JSON ({err})") from err


def value_of(field: Any) -> Any:
    return field.get("value") if isinstance(field, dict) and "value" in field else field


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def record_problems(record: Any) -> List[str]:
    if not isinstance(record, dict):
        return ["record: must be a JSON object"]
    problems = []
    for key in ("source", "source_ref", "requester", "request", "ticket_type", "work_kind", "weight"):
        if not _text(record.get(key)):
            problems.append(f"record: missing '{key}'")
    if record.get("weight") not in (None, "light", "full"):
        problems.append("record: 'weight' must be light or full")
    if not isinstance(record.get("search_terms"), list) or not record.get("search_terms"):
        problems.append("record: 'search_terms' must be a non-empty list")
    if not isinstance(record.get("unresolved"), list):
        problems.append("record: 'unresolved' must be a list")
    if not isinstance(record.get("contains_patient_data"), bool):
        problems.append("record: 'contains_patient_data' must be true or false")
    return problems


def proposal_problems(proposal: Any) -> List[str]:
    if not isinstance(proposal, dict):
        return ["proposal: must be a JSON object"]
    problems = []
    action = proposal.get("action")
    if action not in ACTIONS:
        return ["proposal: missing 'action'" if action is None else "proposal: 'action' must be create or comment_on_match"]
    if not isinstance(proposal.get("gaps", []), list):
        problems.append("proposal: 'gaps' must be a list")
    if action == "comment_on_match":
        match = proposal.get("match")
        if not isinstance(match, dict) or not _text(match.get("key")) or not _text(match.get("request")):
            problems.append("proposal: 'match' needs a key and the request, restated")
        return problems
    if proposal.get("shape") not in SHAPES:
        problems.append("proposal: 'shape' must be single, parent_with_subtasks or epic_with_tickets")
    if not isinstance(proposal.get("route"), dict):
        problems.append("proposal: missing 'route'")
    tickets = proposal.get("tickets")
    if not isinstance(tickets, list) or not tickets:
        problems.append("proposal: 'tickets' must be a non-empty list")
        return problems
    refs = set()
    for position, ticket in enumerate(tickets, start=1):
        label = f"ticket {position}"
        if not isinstance(ticket, dict):
            problems.append(f"{label}: must be an object")
            continue
        ref = _text(ticket.get("ref"))
        label = f"ticket {ref or position}"
        if not ref:
            problems.append(f"{label}: missing 'ref'")
        elif ref in refs:
            problems.append(f"{label}: 'ref' repeats")
        refs.add(ref)
        for key in ("type", "summary", "work_kind"):
            if not _text(ticket.get(key)):
                problems.append(f"{label}: missing '{key}'")
        if not isinstance(ticket.get("sections"), dict):
            problems.append(f"{label}: missing 'sections'")
    return problems


def revision_problems(proposal: Any) -> List[str]:
    """A revision is a ticket proposal with `action: revise`, written by triage's `revise` step. It holds exactly one
    ticket, which names the existing ticket by `key` and carries the whole ticket text (a script rewrites the
    description from it), the `closes` list of gap numbers it answers and the `authors` session ids."""
    if not isinstance(proposal, dict):
        return ["revision: must be a JSON object"]
    if proposal.get("action") != "revise":
        return ["revision: 'action' must be revise"]
    problems = []
    tickets = proposal.get("tickets")
    if not isinstance(tickets, list) or len(tickets) != 1 or not isinstance(tickets[0], dict):
        return ["revision: 'tickets' must hold exactly one ticket"]
    ticket = tickets[0]
    for key in ("key", "type", "repository", "where_it_runs"):
        if not _text(ticket.get(key)):
            problems.append(f"revision: ticket is missing '{key}'")
    if not isinstance(ticket.get("sections"), dict) or not ticket.get("sections"):
        problems.append("revision: ticket is missing 'sections'")
    closes = proposal.get("closes")
    if not isinstance(closes, list) or not all(isinstance(n, int) and not isinstance(n, bool) for n in closes):
        problems.append("revision: 'closes' must be a list of gap numbers")
    authors = proposal.get("authors")
    if not isinstance(authors, list) or not authors or not all(isinstance(a, str) and a.strip() for a in authors):
        problems.append("revision: 'authors' must list the session id of every step that wrote it (the sign-off "
                        "check needs them)")
    return problems


def load_revision(value: Any) -> dict:
    return _load(value, revision_problems)


def question_problems(proposal: Any) -> List[str]:
    """What the `revise` step returns with the outcome needs_josh: the one question, its recommendation and why."""
    if not isinstance(proposal, dict) or proposal.get("action") != "revise":
        return ["question: 'action' must be revise"]
    ask = proposal.get("needs_josh")
    if not isinstance(ask, dict):
        return ["question: missing 'needs_josh'"]
    return [f"question: '{k}' is empty" for k in ("question", "recommendation", "reason") if not _text(ask.get(k))]


def load_question(value: Any) -> dict:
    return _load(value, question_problems)['needs_josh']


def _load(value: Any, checker) -> dict:
    data = load_json(value)
    problems = checker(data)
    if problems:
        raise ContractError("; ".join(problems))
    return data


def load_record(value: Any) -> dict:
    return _load(value, record_problems)


def load_proposal(value: Any) -> dict:
    return _load(value, proposal_problems)
