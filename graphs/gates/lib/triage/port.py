"""Reading a ticket and its history from Jira for the triage gates (JP-122). Python 3.9, standard library only.

Every read here is through the shared client (`lib/jira.py`, JP-121) and ends in a value or a GateError. A read that
fails half way is never a smaller ticket: unknown is not empty (the action-triage#88 rule), so the gate stops and the
walker stops the run with the reason. Nothing in this module writes.
"""
from __future__ import annotations

import os
from typing import List, NamedTuple, Optional

from lib.gate_run import GateError
from lib.jira import FLAG_FIELD
from lib.triage import AGENT_STATUS_FIELDS, QUEUED, RUN_LABEL
from lib.triage import copy, times
from lib.triage.ticket import Ticket, ticket_from_issue, ticket_version

FIELDS = ["summary", "status", "issuetype", "labels", "parent", "description", "issuelinks", "created", FLAG_FIELD,
          "creator", "subtasks"]
AUTHORS_PROPERTY = "josh360.authors"
ROUTE_PROPERTY = "josh360.route"
SPEC_PROPERTY = "action-triage.spec"


class Snapshot(NamedTuple):
    ticket: Ticket
    version: str
    authors: List[str]
    issue: dict            # the shared client's Jira.get result (carries the raw fields)


def read_ticket(jira, key: str, subtasks: bool = True) -> Snapshot:
    issue = jira.get(key, FIELDS)
    if issue is None:
        raise GateError("{} could not be read from Jira".format(key))
    subs: List[Ticket] = []
    if subtasks:
        for row in (issue.get("fields") or {}).get("subtasks") or []:
            sub = jira.get(row.get("key"), [f for f in FIELDS if f != "subtasks"])
            if sub is None:
                raise GateError("subtask {} of {} could not be read from Jira".format(row.get("key"), key))
            subs.append(ticket_from_issue(sub))
    ticket = ticket_from_issue(issue, subs)
    return Snapshot(ticket, ticket_version(ticket), read_authors(jira, key), issue)


def read_authors(jira, key: str) -> List[str]:
    state, value = jira.read_property(key, AUTHORS_PROPERTY)
    if state == "unknown":
        raise GateError("the authors of {} could not be read from Jira".format(key))
    if state == "unset":
        return []
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise GateError("{} on {} is not a list of session ids".format(AUTHORS_PROPERTY, key))
    return list(value)


def read_route(jira, key: str) -> Optional[dict]:
    """The route record, or None when the ticket has none. A property that cannot be read stops the gate."""
    state, value = jira.read_property(key, ROUTE_PROPERTY)
    if state == "unknown":
        raise GateError("the route record on {} could not be read from Jira".format(key))
    return value if state == "set" and isinstance(value, dict) else None


def read_work_kind(jira, key: str) -> Optional[str]:
    """The work kind from the ticket's action-triage.spec property, or None when it has none."""
    state, value = jira.read_property(key, SPEC_PROPERTY)
    if state == "unknown":
        raise GateError("the spec property on {} could not be read from Jira".format(key))
    kind = value.get("type") if state == "set" and isinstance(value, dict) else None
    return kind if isinstance(kind, str) else None


def read_history(jira, key: str):
    """(changelog, comments), oldest first."""
    changelog = jira.changelog(key)
    if changelog is None:
        raise GateError("the history of {} could not be read from Jira".format(key))
    comments = jira.comments(key)
    if comments is None:
        raise GateError("the comments on {} could not be read from Jira".format(key))
    return changelog, comments


def last_description_edit(changelog: List[dict], created: str) -> str:
    """When the description last changed (or the ticket was created, when it never did)."""
    edits = [c["created"] for c in changelog if any(i.get("field") == "description" for i in c.get("items") or [])]
    latest = created
    for moment in edits:
        if times.later(moment, latest):
            latest = moment
    return latest


def send_back_after_edit(comments: List[dict], changelog: List[dict], created: str) -> bool:
    """C12's last clause: a Triage send-back comment newer than the description's last edit means its gaps are open."""
    edit = last_description_edit(changelog, created)
    return any(copy.is_send_back(c.get("body")) and times.later(c.get("created"), edit) for c in comments)


def queued_by(changelog: List[dict]) -> Optional[str]:
    """The account that last changed Agent Status to Queued, or None when nobody did."""
    who = None
    for change in changelog:
        for item in change.get("items") or []:
            if item.get("fieldId") in AGENT_STATUS_FIELDS and item.get("to") == QUEUED:
                who = change.get("author") or None
    return who


def allowed_accounts(jira, environ=None) -> List[str]:
    """The accounts whose tickets are Josh's: the ones action-triage's start gate already uses
    (ACTION_AGENT_JIRA_ALLOWED_ACCOUNTS), JOSH360_JIRA_ALLOWED_ACCOUNTS first, else the account the credentials are."""
    env = os.environ if environ is None else environ
    named = env.get("JOSH360_JIRA_ALLOWED_ACCOUNTS") or env.get("ACTION_AGENT_JIRA_ALLOWED_ACCOUNTS") or ""
    accounts = [a.strip() for a in named.split(",") if a.strip()]
    if accounts:
        return accounts
    me = jira.myself()
    if me is None:
        raise GateError("the account behind the Jira credentials could not be read, so no ticket can be called Josh's")
    return [me]


def author_kind(creator: Optional[str], allowed: List[str]) -> str:
    return "own" if creator and creator in allowed else "other"


def has_run_label(issue: dict) -> bool:
    """True when the ticket carries the label that says it may be run, so it starts as soon as it is Ready."""
    return RUN_LABEL in (((issue.get("fields") or {}).get("labels")) or [])


class CommentPort:
    """The two calls `gate_run.say` needs (read the comments, post one), over the shared client, each ending in a
    GateError when Jira does not confirm."""

    def __init__(self, jira):
        self.jira = jira

    def comments(self, key: str):
        rows = self.jira.comments(key)
        if rows is None:
            raise GateError("the comments on {} could not be read from Jira".format(key))
        return [Row(r["body"]) for r in rows]

    def comment(self, key: str, text: str) -> None:
        if not self.jira.comment(key, text):
            raise GateError("the comment on {} was not confirmed by Jira".format(key))


class Row(NamedTuple):
    body: str
