"""Shared helpers for the triage graph tests (JP-122). Every ticket, key, session and text here is made up."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import ticket_creation_helpers as h
from ticket_creation_helpers import ROOT

sys.path.insert(0, str(ROOT / "graphs" / "gates"))
from lib import adf  # noqa: E402

ME = "acct-josh"            # the fake's own account: tickets it created are Josh's
OTHER = "acct-someone-else"
CREATED = "2026-11-17T09:00:00.000+0000"


VALIDATION_YES = """- Needed: yes
- Starts: at Deployed
- Check every: 1 day
- Complete when: 7 checks in a row pass
- Give up after: 21 days

```gherkin
@validate
Scenario: The install job runs clean
  When the watch reads job laptop-follow
  Then last_exit is 0
  And hours_since_run is at most 2

@validate
Scenario: The doctor reports no failed check
  When the watch reads report doctor summary.fail
  Then value is 0
```"""


def description(**over):
    """The ADF description a script would write for a complete Story. `validation=` is the text of its Validation
    section (the default says Needed: no)."""
    validation = over.pop("validation", None)
    sections = h.section_set(**over.pop("sections", {}))
    if validation is not None:
        sections["validation"] = validation
    return adf.ticket_description({"type": over.pop("type", "Story"), "sections": sections,
                                   "repository": over.pop("repository", "josh-360"),
                                   "where_it_runs": over.pop("where_it_runs", "Cloud session")})


def issue(key="JP-9001", creator=ME, status="Not Started", type_="Story", labels=None, desc=None, **over):
    fields = {"summary": "Add a dry-run flag to the laptop install script", "status": {"name": status},
              "issuetype": {"name": type_}, "labels": ["josh-360"] if labels is None else labels,
              "description": desc if desc is not None else description(), "issuelinks": [], "created": CREATED,
              "creator": {"accountId": creator}, "parent": {"key": "JP-94"}, "subtasks": []}
    fields.update(over)
    return {"key": key, "fields": fields}


def seed(folder, issues, properties=None, comments=None):
    """Write a fake Jira state: `issues` is a list of issue dicts."""
    state = {"issues": {i["key"]: i for i in issues}, "properties": properties or {}, "comments": comments or {}}
    Path(folder, "fake-jira.json").write_text(json.dumps(state))
    return state
