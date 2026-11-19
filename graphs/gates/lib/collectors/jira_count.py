"""Collector `jira-count`: how many tickets a JQL search finds (JP-166).

The argument is the JQL, kept as text and handed to Jira's search with the credentials the runner already has. It is
never run, split or expanded here. `since` is not used: the JQL carries its own dates. More than 200 results is unknown,
because the count would be a floor and not a count.
"""
from __future__ import annotations

import re
import urllib.parse

from . import reading

FIELDS = {"count": "number", "events": "number"}
COUNTS_EVENTS = True
ARGUMENT = re.compile(r"^[^\r\n]{1,500}$")
LIMIT = 200


def read(argument: str, since: str, deps) -> dict:
    try:
        if ARGUMENT.fullmatch(argument or "") is None:
            return reading.take(None, FIELDS)
        jira = deps.jira
        rows = jira.search(argument, ["status"], LIMIT + 1)
        if rows is None or len(rows) > LIMIT:
            return reading.take(None, FIELDS)
        link = jira.site + "/issues/?jql=" + urllib.parse.quote(argument)
        return reading.take({"count": len(rows), "events": len(rows)}, FIELDS, link=link)
    except Exception:
        return reading.take(None, FIELDS)
