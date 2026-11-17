#!/usr/bin/env python3
"""Completeness check on a ticket proposal, with no model.

Inputs: GRAPH_INPUT_PROPOSAL, GRAPH_INPUT_SOURCE, GRAPH_INPUT_SOURCE_REF, GRAPH_INPUT_INTAKE_RECORD,
        GRAPH_INPUT_ROUTE, GRAPH_INPUT_CANDIDATES.
Outputs: problems (one line each, never quoting text), card (the approval card on pass; on needs_josh, the one
         question Josh is asked).
Outcomes: pass, fixable, needs_josh.
Rule: every ticket passes the per-type Ready checklist (lib/ready_checklist.py, owned with JP-122), plus the creation
checks: a summary of at most 255 characters on one line, a parent epic or an area, no unclear type or work kind, and
the patient-data screen on every field (labelled identifiers; and, when the intake record says the input holds patient
data, any 10-character run copied from the source's own words). A missing section the drafter can write is fixable. An entry in the proposal's gaps, an unclear type or work
kind, or no parent and no area is needs_josh. A proposal the drafter wrote badly (not JSON, no tickets) is fixable.

Built in JP-121 from the design in docs/design/ticket-creation-graph.md.
"""
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(ROOT / "scripts"))

import conventions  # noqa: E402
from lib import card, patient_data, ready_checklist, sources  # noqa: E402
from lib.contracts import (ContractError, TICKET_TYPES, WORK_KINDS, load_json, load_proposal,  # noqa: E402
                           load_record)
from lib.gate_io import finish, read_inputs  # noqa: E402

SUMMARY_LIMIT = 255


def flatten(ticket):
    """(field name, text) for every text the ticket would write to Jira."""
    rows = [("summary", ticket.get("summary")), ("where_it_runs", ticket.get("where_it_runs"))]
    for name, value in (ticket.get("sections") or {}).items():
        if isinstance(value, list):
            value = "\n".join(str(v) for v in value)
        rows.append((name, value if isinstance(value, str) else ""))
    return [(n, t) for n, t in rows if isinstance(t, str) and t.strip()]


def has_area(label, registry):
    answer = conventions.lookup_repo(registry, label)
    return bool(answer.get("area"))


def check(proposal, source_text, registry):
    """(fixable problems, needs-Josh problems). Never quotes a ticket's text."""
    fixable, ask = [], []
    for gap in proposal.get("gaps") or []:
        ask.append(str(gap))
    if proposal["action"] == "comment_on_match":
        for kind in patient_data.scan(proposal["match"]["request"], source_text, False, external=True):
            fixable.append(f"match.request: {kind}")
        return fixable, ask
    route = proposal.get("route") or {}
    labels = route.get("labels") or []
    if not (route.get("parent") or route.get("area") or any(has_area(label, registry) for label in labels)):
        ask.append("Which epic or area does this belong to?")
    for ticket in proposal["tickets"]:
        ref = ticket["ref"]
        if ticket["type"] == "unclear":
            ask.append(f"Is {ref} a story, task, bug, research or epic?")
        elif ticket["type"] not in TICKET_TYPES + ("Subtask",):
            fixable.append(f"{ref}: type '{ticket['type']}' is not one of {', '.join(TICKET_TYPES)}, Subtask")
        if ticket["work_kind"] == "unclear":
            ask.append(f"What kind of work is {ref}: {', '.join(WORK_KINDS)}?")
        elif ticket["work_kind"] not in WORK_KINDS:
            fixable.append(f"{ref}: work kind '{ticket['work_kind']}' is not one of {', '.join(WORK_KINDS)}")
        summary = ticket["summary"]
        if len(summary) > SUMMARY_LIMIT:
            fixable.append(f"{ref}: summary is {len(summary)} characters; Jira allows {SUMMARY_LIMIT}")
        if "\n" in summary or "\r" in summary:
            fixable.append(f"{ref}: summary has a line break")
        if ticket["type"] in ticket_types_with_checklist():
            fixable += ready_checklist.problems(ticket)
        for field, text in flatten(ticket):
            for kind in patient_data.scan(text, source_text, False, external=True):
                fixable.append(f"{ref}.{field}: {kind}")
    return fixable, ask


def ticket_types_with_checklist():
    return tuple(ready_checklist.CHECKLIST)


def question(ask, suggestions=None):
    lines = ["One answer is needed before the ticket can be drafted:"] + [f"- {a}" for a in ask]
    if suggestions:
        lines.append("Suggested epics: " + "; ".join(suggestions))
    return "\n".join(lines)


def open_epics():
    """Up to three open JP epics, best effort, only when Jira credentials are present."""
    if not (os.environ.get("JOSH360_JIRA_TOKEN") and (os.environ.get("JOSH360_JIRA_EMAIL")
                                                      or os.environ.get("ACTION_AGENT_JIRA_EMAIL"))):
        return []
    from lib.jira import Jira

    rows = Jira.from_env().search('project = JP AND issuetype = Epic AND statusCategory != Done ORDER BY created DESC',
                                  ["summary"], limit=3) or []
    return [f"{r['key']} {r['fields'].get('summary', '')}" for r in rows]


if __name__ == "__main__":
    values = read_inputs(["proposal", "source", "source_ref", "intake_record", "route", "candidates"])
    try:
        proposal = load_proposal(values["proposal"])
    except ContractError as err:
        finish("fixable", {"problems": [f"proposal: {err}"], "card": ""}, "the proposal is not well-formed")
    registry = json.loads((ROOT / "conventions" / "registry.json").read_text(encoding="utf-8"))
    try:
        record = load_record(values["intake_record"]) if values["intake_record"] else None
    except ContractError:
        record = None
    # The copy check compares ticket text with the source's own words. It applies when the reader says the input holds
    # patient data (or when the record is unreadable, because unknown is not "no"): a ticket restates a harmless
    # request in shared words, so a 10-character match alone proves nothing there.
    text = ""
    if record is None or record["contains_patient_data"]:
        text = sources.source_text(values["source"] or "", values["source_ref"] or "")
    fixable, ask = check(proposal, text, registry)
    if fixable:
        finish("fixable", {"problems": fixable, "card": ""}, f"{len(fixable)} problem(s) the drafter can fix")
    if ask:
        finish("needs_josh", {"problems": ask, "card": question(ask, open_epics() if any(
            "epic or area" in a for a in ask) else None)}, f"{len(ask)} question(s) for Josh")
    try:
        candidates = load_json(values["candidates"]) if values["candidates"] else []
    except ContractError:
        candidates = []
    record = record or {}
    link = values["proposal"] if values["proposal"] and not values["proposal"].lstrip().startswith(("{", "[")) \
        else "(in the run folder)"
    text_card = card.render(proposal, candidates if isinstance(candidates, list) else [], link,
                            source=values["source"] or "", search_terms=record.get("search_terms"),
                            weight=record.get("weight", ""))
    finish("pass", {"problems": [], "card": text_card}, "complete")
