#!/usr/bin/env python3
"""Snapshot JP's real Jira workflow for the strict fake Jira (JP-187). Read-only: it makes no write to Jira.

  python3 scripts/jira_snapshot.py [--project JP] [--out graphs/gates/jira-snapshot/JP.json]

Credentials as for the gate scripts (JOSH360_JIRA_EMAIL and JOSH360_JIRA_TOKEN). It saves the project's statuses,
its transition ids with their targets and the statuses each leads from, its issue types with each create screen's
fields, the custom field ids with the allowed values of option fields, the link types and the priorities. It saves
no ticket text: only ids, names and allowed values. Two things Jira's REST API does not say without admin rights are
kept from the file being replaced: the workflow's first status and the shape of the josh360.route property (the
route is Josh 360's own record; graphs/gates/mark-ready.py writes it).

A workflow's transitions are read from one ticket in each status. When every status read gives the same list (JP is
a team-managed project, whose transitions lead from any status), each transition leads from every status; otherwise
only from the statuses where it was seen. `transitions_observed_from` names the statuses read.

Python 3.9, standard library only. Exit 0 when written, 1 when Jira could not be read.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path
from typing import Dict, List, Optional

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "graphs" / "gates"))

from lib.jira import Jira, JiraError  # noqa: E402

DEFAULT_OUT = ROOT / "graphs" / "gates" / "jira-snapshot" / "JP.json"
READ_ONLY_FIELDS = ("Sprint",)   # read by the gates (JQL openSprints) but not on any create screen
DEFAULT_ROUTE = {"source": "graphs/gates/mark-ready.py",
                 "keys": {"graph": "string", "system": "string", "space": "string", "version": "string",
                          "run": "string", "signed_by": "string", "returns": "integer", "returns_seen": "integer",
                          "returned_from": "string"}}


class Unreadable(Exception):
    pass


def _read(jira, path: str, params: Optional[dict] = None, body: Optional[dict] = None):
    try:
        parsed = jira.read_json(path, params, body)
    except JiraError as err:
        raise Unreadable(str(err))
    if parsed is None:
        raise Unreadable("no answer from Jira for " + path)
    return parsed


def _options(field: dict) -> Optional[List[str]]:
    schema = field.get("schema") or {}
    kind = schema.get("items") if schema.get("type") == "array" else schema.get("type")
    if kind != "option":
        return None
    return [v.get("value") for v in field.get("allowedValues") or [] if v.get("value")]


def _transitions(jira, project: str, statuses: List[dict]) -> tuple:
    seen: Dict[str, List[dict]] = {}
    for status in statuses:
        found = _read(jira, "/rest/api/3/search/jql",
                      body={"jql": 'project = {} AND status = {}'.format(project, status["id"]),
                            "fields": ["status"], "maxResults": 1})
        rows = found.get("issues") or []
        if not rows:
            continue
        parsed = _read(jira, "/rest/api/3/issue/{}/transitions".format(rows[0]["key"]))
        seen[status["name"]] = [{"id": str(t["id"]), "name": t.get("name") or "", "to": (t.get("to") or {})["name"]}
                                for t in parsed.get("transitions") or []]
    if not seen:
        raise Unreadable("no ticket in any status, so no transition could be read")
    lists = list(seen.values())
    everywhere = all(sorted(x["id"] for x in rows) == sorted(x["id"] for x in lists[0]) for rows in lists)
    out: Dict[str, dict] = {}
    for name, rows in seen.items():
        for row in rows:
            entry = out.setdefault(row["id"], dict(row, **{"from": []}))
            entry["from"].append(name)
    order = [s["name"] for s in statuses]
    for entry in out.values():
        entry["from"] = order if everywhere else [n for n in order if n in entry["from"]]
    observed = [n for n in order if n in seen]
    return sorted(out.values(), key=lambda t: int(t["id"]) if t["id"].isdigit() else 0), observed


def snapshot(jira, project: str, previous: Optional[dict] = None, today: Optional[str] = None) -> dict:
    previous = previous or {}
    info = _read(jira, "/rest/api/3/project/{}".format(project))
    per_type = _read(jira, "/rest/api/3/project/{}/statuses".format(project))
    statuses: Dict[str, dict] = {}
    for row in per_type:
        for status in row.get("statuses") or []:
            statuses.setdefault(status["id"], {"id": status["id"], "name": status["name"],
                                               "category": (status.get("statusCategory") or {}).get("key") or ""})
    order = {"new": 0, "indeterminate": 1, "done": 2}
    status_list = sorted(statuses.values(), key=lambda s: (order.get(s["category"], 3), int(s["id"])))
    types = _read(jira, "/rest/api/3/issue/createmeta/{}/issuetypes".format(project)).get("issueTypes") or []
    issue_types, custom, priorities = [], {}, set()
    for row in types:
        meta = _read(jira, "/rest/api/3/issue/createmeta/{}/issuetypes/{}".format(project, row["id"]),
                     params={"maxResults": 200})
        fields = meta.get("fields") or meta.get("values") or []
        issue_types.append({"id": row["id"], "name": row["name"], "subtask": bool(row.get("subtask")),
                            "create_fields": sorted(f["fieldId"] for f in fields),
                            "required": sorted(f["fieldId"] for f in fields if f.get("required"))})
        for field in fields:
            if field["fieldId"].startswith("customfield_"):
                entry = custom.setdefault(field["fieldId"], {"name": field.get("name") or ""})
                options = _options(field)
                if options is not None:
                    entry["options"] = options
            if field["fieldId"] == "priority":
                priorities.update(v.get("name") for v in field.get("allowedValues") or [] if v.get("name"))
    for field in _read(jira, "/rest/api/3/field"):
        if field.get("name") in READ_ONLY_FIELDS and field.get("id") not in custom:
            custom[field["id"]] = {"name": field["name"], "settable": False}
    transitions, observed = _transitions(jira, project, status_list)
    links = _read(jira, "/rest/api/3/issueLinkType").get("issueLinkTypes") or []
    rank = {"Highest": 0, "High": 1, "Medium": 2, "Low": 3, "Lowest": 4}
    return {
        "about": "JP's real Jira workflow, read-only, for the strict fake Jira (JP-187). No ticket text. "
                 "Refresh with scripts/jira_snapshot.py.",
        "version": 1,
        "taken": today or date.today().isoformat(),
        "taken_by": "scripts/jira_snapshot.py (read-only)",
        "site": jira.site,
        "project": {"key": info["key"], "id": str(info["id"]), "simplified": bool(info.get("simplified"))},
        "initial_status": previous.get("initial_status") or status_list[0]["name"],
        "statuses": status_list,
        "transitions": transitions,
        "transitions_observed_from": observed,
        "issue_types": sorted(issue_types, key=lambda t: int(t["id"])),
        "custom_fields": {k: custom[k] for k in sorted(custom)},
        "priorities": sorted(priorities, key=lambda p: rank.get(p, 9)),
        "link_types": sorted(({"name": t["name"], "inward": t.get("inward") or "", "outward": t.get("outward") or ""}
                              for t in links), key=lambda t: t["name"].casefold()),
        "properties": previous.get("properties") or {"josh360.route": DEFAULT_ROUTE},
    }


def main(argv: Optional[List[str]] = None, jira=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--project", default="JP")
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    args = parser.parse_args(argv)
    out = Path(args.out)
    previous = json.loads(out.read_text(encoding="utf-8")) if out.is_file() else None
    try:
        doc = snapshot(jira or Jira.from_env(), args.project, previous)
    except (Unreadable, KeyError, TypeError) as err:
        print("Jira could not be read, nothing written: {}".format(err), file=sys.stderr)
        return 1
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=1) + "\n", encoding="utf-8")
    print("wrote {}: {} statuses, {} transitions, {} issue types, {} custom fields".format(
        out, len(doc["statuses"]), len(doc["transitions"]), len(doc["issue_types"]), len(doc["custom_fields"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
