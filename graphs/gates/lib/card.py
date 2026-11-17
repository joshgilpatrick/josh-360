"""The approval card text (JP-121). Exact wording: docs/design/ticket-creation-graph.md, "The approval card".

The walker shows this text as the `approve` ask's detail in the Needs you tab, which draws the buttons, so the card
here has no button row.

    render(proposal, candidates, proposal_link, precedent=None, source="", search_terms=None) -> str
    stage3_comment(decision, category) -> str
"""
from __future__ import annotations

from typing import List, Optional

SOURCES = {"todo": "a to-do", "email": "an email", "session": "a session", "manual": "a request by hand",
           "notion": "a Notion item"}
RULES = {"repository": "by its repository", "folder": "by its folder", "named": "as you named it",
         "fallback": "no registry rule matched"}


def stage3_comment(decision: str, category: str) -> str:
    return f"Created without asking, under decision {decision} ({category}). Cancel this ticket to overrule it."


def _joined(items: List[str]) -> str:
    return ", ".join(items)


def _quoted(terms: Optional[List[str]]) -> str:
    return ", ".join(f'"{t}"' for t in terms or [])


def _field_names(refs: List[str], tickets: List[dict]) -> List[str]:
    """Field names for the card's Inferred line. The first field of an epic is named "the epic's ...", the rest plain."""
    names, owners = [], set()
    for ref in refs:
        ticket_ref, _, field = ref.partition(".")
        field = (field or ref).replace("_", " ")
        ticket = next((t for t in tickets if t.get("ref") == ticket_ref), {})
        if ticket.get("type") == "Epic" and ticket_ref not in owners:
            owners.add(ticket_ref)
            field = f"the epic's {field}"
        names.append(field)
    return names


def _scenarios(ticket: dict) -> int:
    return str((ticket.get("sections") or {}).get("acceptance_criteria") or "").count("Scenario")


def _heading(precedent: Optional[dict]) -> List[str]:
    if not precedent:
        return []
    return [f"Suggested: approve, as you did for {precedent['decision']} on {precedent['date']} "
            f"({precedent['category']})", ""]


def _where(route: dict) -> str:
    space = route.get("space") or "JP"
    if route.get("parent"):
        return f"{space} under {route['parent']}"
    return space


def _home(route: dict) -> str:
    rule = RULES.get(route.get("rule"), "")
    parts = [p for p in (route.get("system"), rule) if p]
    text = ", ".join(parts)
    if route.get("area"):
        text = (text + "; " if text else "") + f"area: {route['area']}"
    return text


def _open_match(proposal: dict, candidates: List[dict]) -> List[str]:
    match = proposal.get("match") or {}
    cand = next((c for c in candidates if c.get("key") == match.get("key")), {})
    title = cand.get("summary") or match.get("summary") or ""
    status = match.get("status") or cand.get("status") or ""
    lines = [f'Already open: {match.get("key")}, "{title}" ({status})', "",
             f"Add a comment to {match.get('key')} with this request, and stop?"]
    if cand.get("why"):
        lines.append(f"Matched on {cand['why']}.")
    return lines


def _duplicates(proposal: dict, candidates: List[dict], search_terms) -> str:
    match = proposal.get("match") or {}
    if match.get("key"):
        return ""
    return f"Duplicates: none (searched JP, AD, CI for {_quoted(search_terms)})." if search_terms else \
        "Duplicates: none (searched JP, AD, CI)."


def _single(proposal: dict, ticket: dict, route: dict, weight: str, inferred: List[str], candidates, terms) -> List[str]:
    runs = str(ticket.get("where_it_runs") or "").strip()
    runs = (runs[:1].lower() + runs[1:]) if runs else ""
    if runs.startswith("cloud session"):
        runs = "a " + runs
    if f"{ticket.get('ref')}.where_it_runs" in inferred and runs:
        runs += " (inferred)"
    facts = " · ".join(p for p in (ticket.get("type"), ticket.get("work_kind"), weight,
                                   f"runs in {runs}" if runs else "") if p)
    count = _scenarios(ticket)
    own = [r for r in inferred if r.startswith(f"{ticket.get('ref')}.")]
    names = _field_names([r for r in own if not r.endswith(".where_it_runs")], proposal["tickets"]) + (
        ["where it runs"] if f"{ticket.get('ref')}.where_it_runs" in inferred else [])
    lines = [f"Create in {_where(route)} ({_home(route)})", facts,
             f"Goal: {(ticket.get('sections') or {}).get('goal', '')}",
             f"{count} scenario{'s' if count != 1 else ''}." + (f" Inferred: {_joined(names)}." if names else "")]
    return lines


def _family(proposal: dict, route: dict) -> List[str]:
    tickets = proposal["tickets"]
    parent = tickets[0]
    children = tickets[1:]
    sections = parent.get("sections") or {}
    kind = "epic" if parent.get("type") == "Epic" else "parent ticket"
    lines = [f"Create in {route.get('space') or 'JP'}: 1 {kind} and {len(children)} ticket"
             f"{'s' if len(children) != 1 else ''} ({_home(route)})"]
    if parent.get("type") == "Epic":
        lines.append(f"Epic: {parent.get('summary')}. Done when: {sections.get('done_when', '')}.")
        lines.append(f"Branch strategy: {sections.get('branch_strategy', '')}.")
    else:
        lines.append(f"Parent: {parent.get('summary')}")
    numbers = {t.get("ref"): i for i, t in enumerate(children, start=1)}
    for position, child in enumerate(children, start=1):
        line = f"  {position}. {child.get('type')}: {child.get('summary')}."
        if child.get("delivers"):
            line += f" Delivers {child['delivers']}."
        for link in child.get("links") or []:
            if link.get("kind") == "blocked_by" and link.get("target") in numbers:
                line += f" Blocked by {numbers[link['target']]}."
        lines.append(line)
    return lines


def render(proposal: dict, candidates: List[dict], proposal_link: str, precedent: Optional[dict] = None,
           source: str = "", search_terms: Optional[List[str]] = None, weight: str = "") -> str:
    candidates = candidates or []
    out = _heading(precedent)
    if proposal.get("action") == "comment_on_match":
        return "\n".join(out + _open_match(proposal, candidates))
    tickets = proposal["tickets"]
    route = proposal.get("route") or {}
    inferred = [str(r) for r in proposal.get("inferred") or []]
    what = SOURCES.get(source, "an input")
    if len(tickets) == 1:
        out.append(f"New ticket from {what}: {tickets[0].get('summary')}")
        out.append("")
        out += _single(proposal, tickets[0], route, weight or "", inferred, candidates, search_terms)
    else:
        out.append(f"New tickets from {what}: {tickets[0].get('summary')}")
        out.append("")
        out += _family(proposal, route)
    match = proposal.get("match") or {}
    if match.get("key"):
        out.append(f"Related: {match['key']} ({match.get('status', 'closed')}), linked with Relates.")
    else:
        dup = _duplicates(proposal, candidates, search_terms)
        if dup:
            out.append(dup)
    if len(tickets) > 1 and inferred:
        out.append(f"Inferred: {_joined(_field_names(inferred, tickets))}.")
    out.append(f"Full text: {proposal_link}")
    return "\n".join(out)
