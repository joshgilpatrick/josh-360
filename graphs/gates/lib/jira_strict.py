"""The rules that make the folder fake Jira strict (JP-187): it refuses what JP's real Jira would refuse.

The rules come from a snapshot of JP's real workflow (`graphs/gates/jira-snapshot/JP.json`, written by
`scripts/jira_snapshot.py`, read-only). The fake uses them only when its folder holds a copy named `snapshot.json`;
without one it keeps its old, lenient behaviour, so existing tests are unchanged.

What the snapshot holds and the fake checks:

- statuses (id, name, category) and the workflow's transitions (id, target, the statuses each leads from);
- issue types, with the fields each one's create screen has and which are required;
- custom field ids, with the allowed values of option fields (Flagged, Agent Status, Repository);
- link types and priorities.

A refusal is answered the way Jira answers one: 400 with ``{"errorMessages": [...], "errors": {field: message}}``.
Python 3.9, standard library only.
"""
from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import List, Optional, Tuple

SNAPSHOT = "snapshot.json"   # the copy inside a fake Jira folder that switches the strict rules on
HERE = Path(__file__).resolve().parent.parent / "jira-snapshot"
REPO_SNAPSHOT = HERE / "JP.json"
FIXTURES = HERE / "fixtures"
NOT_EDITABLE = {"project", "issuetype", "attachment", "issuelinks"}
DEFAULTED = {"reporter"}   # Jira fills the reporter in with the caller, so a create may leave it out
_JQL_VALUE = re.compile(r"""\b(status|issuetype|project)\s*(!=|=|not\s+in|in)\s*(\([^)]*\)|"[^"]*"|'[^']*'|[^\s)]+)""",
                        re.I)
_JQL_WORDS = {"empty", "null"}


def refusal(errors: Optional[dict] = None, messages: Optional[List[str]] = None) -> dict:
    return {"errorMessages": list(messages or []), "errors": dict(errors or {})}


def _not_settable(name: str) -> str:
    return "Field '{}' cannot be set. It is not on the appropriate screen, or unknown.".format(name)


def load(folder: Path) -> Optional["Rules"]:
    path = folder / SNAPSHOT
    if not path.is_file():
        return None
    return Rules(json.loads(path.read_text(encoding="utf-8")))


def install(folder: Path, fixtures: Tuple[str, ...] = (), snapshot: Path = REPO_SNAPSHOT) -> Path:
    """Make `folder` a strict fake Jira: the marker file, a copy of the snapshot and the named made-up fixture tickets
    (files in graphs/gates/jira-snapshot/fixtures). An existing marker keeps its state; fixtures are added to it."""
    folder.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(str(snapshot), str(folder / SNAPSHOT))
    marker = folder / "fake-jira.json"
    state = json.loads(marker.read_text(encoding="utf-8")) if marker.is_file() else {}
    for name in fixtures:
        doc = json.loads((FIXTURES / (name + ".json")).read_text(encoding="utf-8"))
        key = doc["key"]
        state.setdefault("issues", {})[key] = {"key": key, "fields": doc["fields"]}
        for prop, value in (doc.get("properties") or {}).items():
            state.setdefault("properties", {})["{}|{}".format(key, prop)] = value
    marker.write_text(json.dumps(state), encoding="utf-8")
    return folder


class Rules:
    def __init__(self, snap: dict):
        self.snap = snap
        self.project = snap["project"]
        self.statuses = {s["name"]: s for s in snap["statuses"]}
        self.types = snap["issue_types"]
        self.custom = snap.get("custom_fields") or {}
        self.link_names = {t["name"].casefold(): t for t in snap.get("link_types") or []}
        self.priorities = set(snap.get("priorities") or [])

    # -- what a value looks like on the wire ------------------------------------------------------------------

    def status(self, name: str) -> Optional[dict]:
        row = self.statuses.get(name)
        if row is None:
            return None
        return {"name": row["name"], "id": row["id"], "statusCategory": {"key": row["category"]}}

    def initial(self) -> dict:
        return self.status(self.snap["initial_status"])

    def issue_type(self, ref) -> Optional[dict]:
        ref = ref or {}
        for row in self.types:
            if ref.get("id") == row["id"] or (ref.get("name") or "").casefold() == row["name"].casefold():
                return row
        return None

    def wire_type(self, row: dict) -> dict:
        return {"id": row["id"], "name": row["name"], "subtask": row["subtask"]}

    def dress(self, issue: dict) -> Optional[str]:
        """Fill in a stored issue's status and type the way Jira returns them. A problem names what JP lacks."""
        fields = issue.setdefault("fields", {})
        name = (fields.get("status") or {}).get("name")
        if name is not None:
            status = self.status(name)
            if status is None:
                return "the fake holds {} in status '{}', which JP does not have".format(issue.get("key"), name)
            fields["status"] = status
        if fields.get("issuetype"):
            row = self.issue_type(fields["issuetype"])
            if row is None:
                return "the fake holds {} as issue type '{}', which JP does not have".format(
                    issue.get("key"), fields["issuetype"].get("name"))
            fields["issuetype"] = self.wire_type(row)
        return None

    def transitions_from(self, status_name: str) -> List[dict]:
        return [{"id": t["id"], "name": t["name"], "to": self.status(t["to"])}
                for t in self.snap["transitions"] if status_name in t["from"]]

    def createmeta(self) -> dict:
        return {"issueTypes": [self.wire_type(t) for t in self.types], "total": len(self.types)}

    def link_types(self) -> dict:
        return {"issueLinkTypes": [dict(t) for t in self.snap.get("link_types") or []]}

    # -- checks: None when Jira would accept, else a refusal body -------------------------------------------

    def _values(self, row: dict, fields: dict, allowed) -> dict:
        errors = {}
        for name, value in fields.items():
            if name not in allowed:
                errors[name] = _not_settable(name)
                continue
            options = (self.custom.get(name) or {}).get("options")
            if options is not None and value:
                for item in value if isinstance(value, list) else [value]:
                    chosen = item.get("value") if isinstance(item, dict) else None
                    if chosen not in options:
                        errors[name] = "Option value '{}' is not valid".format(chosen)
            if name == "priority" and value and (value or {}).get("name") not in self.priorities:
                errors[name] = "Specify a valid priority"
        return errors

    def check_create(self, data: dict) -> Optional[dict]:
        fields = (data or {}).get("fields") or {}
        project = fields.get("project") or {}
        if project.get("key") != self.project["key"] and project.get("id") != self.project["id"]:
            return refusal({"project": "valid project is required"})
        row = self.issue_type(fields.get("issuetype"))
        if row is None:
            return refusal({"issuetype": "Specify a valid issue type"})
        errors = self._values(row, fields, set(row["create_fields"]))
        for name in row["required"]:
            if name not in DEFAULTED and not fields.get(name):
                errors.setdefault(name, "{} is required.".format(name))
        return refusal(errors) if errors else None

    def check_edit(self, issue: dict, data: dict) -> Optional[dict]:
        row = self.issue_type((issue.get("fields") or {}).get("issuetype"))
        allowed = set(row["create_fields"]) - NOT_EDITABLE if row else set()
        changes = dict((data or {}).get("fields") or {})
        for name in (data or {}).get("update") or {}:
            changes.setdefault(name, None)
        errors = self._values(row or {}, changes, allowed)
        return refusal(errors) if errors else None

    def check_transition(self, issue: dict, data: dict) -> Tuple[Optional[dict], Optional[dict]]:
        """(refusal, None) or (None, the status the transition leads to)."""
        wanted = str(((data or {}).get("transition") or {}).get("id") or "")
        current = ((issue.get("fields") or {}).get("status") or {}).get("name") or ""
        match = next((t for t in self.transitions_from(current) if t["id"] == wanted), None)
        if match is None:
            return refusal(messages=["Transition id '{}' is not valid for this issue.".format(wanted)]), None
        problem = self.check_edit(issue, {"fields": (data or {}).get("fields") or {}})
        return (problem, None) if problem else (None, match["to"])

    def check_link(self, data: dict) -> Optional[dict]:
        name = ((data or {}).get("type") or {}).get("name") or ""
        if name.casefold() not in self.link_names:
            return refusal(messages=["No issue link type with name '{}' found.".format(name)])
        return None

    def check_jql(self, jql: str) -> Optional[dict]:
        """A status, issue type or project the query names that JP does not have is a 400, as in real Jira."""
        known = {"status": {n.casefold() for n in self.statuses} | {s["id"] for s in self.statuses.values()},
                 "issuetype": {t["name"].casefold() for t in self.types} | {t["id"] for t in self.types},
                 "project": {self.project["key"].casefold(), self.project["id"]}}
        for match in _JQL_VALUE.finditer(jql or ""):
            field, raw = match.group(1).lower(), match.group(3)
            values = raw[1:-1].split(",") if raw.startswith("(") else [raw]
            for value in (v.strip().strip("\"'") for v in values):
                if not value or value.lower() in _JQL_WORDS or value.endswith(")"):
                    continue
                if value.casefold() not in known[field]:
                    return refusal(messages=["The value '{}' does not exist for the field '{}'.".format(value, field)])
        return None
