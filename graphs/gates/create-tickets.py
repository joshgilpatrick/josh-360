#!/usr/bin/env python3
"""Writes an approved proposal to Jira, with no model.

Inputs: GRAPH_INPUT_PROPOSAL, GRAPH_INPUT_MATCH_KEY, GRAPH_INPUT_SOURCE, GRAPH_INPUT_SOURCE_REF.
Outputs: ticket_keys (parent first, only tickets Jira confirmed), missing (refs not confirmed).
Outcomes: created, commented, partial.
Rule: an open match gets one comment (the design's fixed text) and nothing else. Otherwise the parent first, then each
child, each in one create (fields, labels, the action-triage.spec and josh360.authors properties), each read back,
then the links. Never sets Agent Status, priority, points, assignee or dates; tickets are created in the space's first
status (Not Started). Before every create it searches the space for the exact summary created in the last day (under
the same parent for a child) and uses that ticket if it is there: that is what makes the walker's single retry after
`partial` safe, and what answers a create Jira did not confirm. A search that cannot answer stops that ticket, so
nothing is created blind.

A follow-up a graph step reported (source `session`, pointer `follow-up:...`, JP-175) gets two things no model
chooses: the label `graph-follow-up` on every ticket written, and, when the follow-up blocks its ticket, a Blocks link
from the first ticket (or the open match commented on) to the ticket the step was working.

Built in JP-121 from the design in docs/design/ticket-creation-graph.md.
"""
import datetime
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib import adf, card, follow_ups  # noqa: E402
from lib.contracts import ContractError, load_proposal  # noqa: E402
from lib.gate_io import fail, finish, read_inputs  # noqa: E402
from lib.jira import Jira, JiraError  # noqa: E402

COMMENT = ('Another request for this came in from {source} on {date}: "{request}". Ticket creation found this '
           'ticket open, so it added this comment instead of a new ticket. Source: {source_ref}.')
FORBIDDEN = ("priority", "assignee", "duedate", "customfield_10452", "customfield_10453", "timetracking")
LINKS = {"blocked_by": ("Blocks", True), "blocks": ("Blocks", False), "relates": ("Relates", False)}


def comment_text(proposal, source, source_ref, today):
    return COMMENT.format(source=card.SOURCES.get(source or "", "an input"), date=today,
                          request=proposal["match"]["request"].strip(), source_ref=source_ref or "")


def find_existing(jira, space, summary, parent_key):
    """The key of a ticket with this exact summary created in the last day (and this parent), "" when none, None
    when Jira could not answer."""
    rows = jira.search(f'project = "{space}" AND created >= -1d ORDER BY created DESC',
                       ["summary", "parent"], limit=100)
    if rows is None:
        return None
    for row in rows:
        fields = row.get("fields") or {}
        if fields.get("summary") == summary and (not parent_key or (fields.get("parent") or {}).get("key") == parent_key):
            return row["key"]
    return ""


def fields_for(ticket, space, parent_key, labels):
    fields = {"project": {"key": space}, "summary": ticket["summary"], "issuetype": {"name": ticket["type"]},
              "description": adf.ticket_description(ticket), "labels": list(labels)}
    if parent_key:
        fields["parent"] = {"key": parent_key}
    for name in FORBIDDEN:
        fields.pop(name, None)
    return fields


def confirmed(jira, key, ticket, parent_key, labels):
    back = jira.get(key)
    if back is None or back["summary"] != ticket["summary"] or not back["description"].strip():
        return False
    if parent_key and back["parent"] != parent_key:
        return False
    return all(label in back["labels"] for label in labels)


def write_ticket(jira, proposal, ticket, parent_key, space, keys, missing):
    route = proposal["route"]
    labels = [str(l) for l in route.get("labels") or []]
    if ticket.get("improvement") and "improvement" not in labels:
        labels.append("improvement")
    key = find_existing(jira, space, ticket["summary"], parent_key)
    if key is None:
        missing.append(ticket["ref"])
        return None
    if not key:
        props = {"action-triage.spec": {"type": ticket["work_kind"]}, "josh360.authors": proposal.get("authors") or []}
        key = jira.create(fields_for(ticket, space, parent_key, labels), props)
        if key is None:  # not confirmed: it may exist, so look for it; never create again
            key = find_existing(jira, space, ticket["summary"], parent_key) or None
    if not key:
        missing.append(ticket["ref"])
        return None
    if jira.get_property(key, "josh360.authors") is None:
        jira.set_property(key, "josh360.authors", proposal.get("authors") or [])
    if jira.get_property(key, "action-triage.spec") is None:
        jira.set_property(key, "action-triage.spec", {"type": ticket["work_kind"]})
    if not confirmed(jira, key, ticket, parent_key, labels):
        missing.append(ticket["ref"])
        return None
    keys[ticket["ref"]] = key
    return key


def create_all(jira, proposal):
    route = proposal["route"]
    space = route.get("space") or "JP"
    tickets = proposal["tickets"]
    keys, missing = {}, []
    top = tickets[0]
    for position, ticket in enumerate(tickets):
        if position == 0:
            parent_key = None if ticket["type"] == "Epic" else route.get("parent")
        else:
            parent_key = keys.get(ticket.get("parent_ref") or top["ref"]) or ticket.get("parent")
            if not parent_key:
                missing.append(ticket["ref"])  # its parent was not confirmed; never file it loose
                continue
        write_ticket(jira, proposal, ticket, parent_key, space, keys, missing)
    refs = {t["ref"] for t in tickets}
    for ticket in tickets:
        key = keys.get(ticket["ref"])
        if not key:
            continue
        for link in ticket.get("links") or []:
            kind, blocked_by = LINKS.get(link.get("kind"), (None, False))
            wanted = link.get("target")
            if not kind or not wanted:
                continue
            target = keys.get(wanted) if wanted in refs else wanted
            if not target:  # the other end is a ticket of this run that Jira did not confirm
                missing.append(f"{ticket['ref']}:link")
                continue
            outward, inward = (target, key) if blocked_by else (key, target)
            if not jira.link(kind, outward, inward):
                missing.append(f"{ticket['ref']}:link")
    match = proposal.get("match") or {}
    if match.get("key") and keys.get(top["ref"]) and not jira.link("Relates", keys[top["ref"]], match["key"]):
        missing.append(f"{top['ref']}:link")
    return [keys[t["ref"]] for t in tickets if t["ref"] in keys], missing


def comment_on_match(jira, proposal, source, source_ref, today, match_key):
    key = proposal["match"]["key"]
    if match_key not in (None, "", "none", key):
        raise ValueError(f"the proposal comments on {key} but the duplicate check found {match_key}")
    text = comment_text(proposal, source, source_ref, today)
    existing = jira.comments(key)
    if existing is None:
        return False
    if any(text.strip() == (c["body"] or "").strip() for c in existing):
        return True  # a repeat after an unconfirmed post: it is already there
    return jira.comment(key, text)


def follow_up_of(source, source_ref):
    """The follow-up file behind this intake item, or None for any other source."""
    if source != "session" or follow_ups.parse_ref(source_ref or "") is None:
        return None
    return follow_ups.load(source_ref) or None


def block_origin(jira, follow, blocker, missing):
    origin = (follow or {}).get("origin")
    if follow and follow.get("blocks") and origin and blocker and not jira.link("Blocks", blocker, origin):
        missing.append("follow-up:link")


def run(jira, proposal, source, source_ref, match_key, today=None):
    """(outcome, outputs). Pure of the environment: the tests hand in a fake Jira."""
    today = today or datetime.date.today().isoformat()
    follow = follow_up_of(source, source_ref)
    if proposal["action"] == "comment_on_match":
        done = comment_on_match(jira, proposal, source, source_ref, today, match_key)
        missing = [] if done else [proposal["match"]["key"]]
        if done:
            block_origin(jira, follow, proposal["match"]["key"], missing)
        return ("commented" if not missing else "partial"), {"ticket_keys": [], "missing": missing}
    if follow:
        route = dict(proposal["route"])
        route["labels"] = list(route.get("labels") or []) + ([follow_ups.LABEL]
                                                             if follow_ups.LABEL not in (route.get("labels") or []) else [])
        proposal = dict(proposal, route=route)
    keys, missing = create_all(jira, proposal)
    if keys:
        block_origin(jira, follow, keys[0], missing)
    return ("created" if not missing else "partial"), {"ticket_keys": keys, "missing": missing}


if __name__ == "__main__":
    values = read_inputs(["proposal", "match_key", "source", "source_ref"])
    try:
        proposal = load_proposal(values["proposal"])
        outcome, outputs = run(Jira.from_env(), proposal, values["source"], values["source_ref"], values["match_key"])
    except (ContractError, ValueError, JiraError) as err:
        fail(f"create-tickets: {err}")
    finish(outcome, outputs, f"{outcome}: {len(outputs['ticket_keys'])} ticket(s)"
           + (f", missing {', '.join(outputs['missing'])}" if outputs["missing"] else ""))
