"""A Jira that lives in a folder, for tests that run the real gate scripts as separate processes (JP-121).

It is used only when JOSH360_JIRA_FAKE names a folder that holds a file called fake-jira.json (the marker; an empty
{} is enough). A real laptop never has that folder, so a stray variable cannot turn real writes into fake ones.

State is kept in <folder>/fake-jira.json (issues, comments, properties) and every request is appended to
<folder>/calls.jsonl, so a test can read what was written and in what order. Python 3.9, standard library only.

Strict (JP-187): when the folder also holds snapshot.json (a copy of graphs/gates/jira-snapshot/JP.json, put there by
`jira_strict.install`), the fake refuses with 400 any status, transition id, issue type, field, option value or link
type that JP's real Jira does not have, answers transitions and create metadata from the snapshot, and returns
statuses and issue types with their real ids. Without the file it is as lenient as before.
"""
from __future__ import annotations

import json
import os
import re
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, Optional, Tuple

from lib import jira_strict

SPRINT_FIELD = "customfield_10020"
FLAG_FIELD = "customfield_10021"      # "Flagged"; the same id as lib.jira.FLAG_FIELD
MARKER = "fake-jira.json"
CALLS = "calls.jsonl"


def folder_from(environ: dict) -> Optional[Path]:
    value = environ.get("JOSH360_JIRA_FAKE")
    if not value:
        return None
    folder = Path(os.path.expanduser(value))
    return folder if (folder / MARKER).is_file() else None


def _judge(issues: list, jql: str) -> Optional[list]:
    """The small JQL subset a test can ask for (JP-117): ORDER BY is dropped, then each ` AND ` clause is one of
    `project = X`, `status = X` (quoted or bare), `labels = X` (quoted or bare), `sprint in openSprints()` and
    `issuetype in (A, B)` and `Flagged is EMPTY`. Any other clause
    returns None (the fake answers 400), so a test can never pass on a rule the fake did not judge."""
    text = re.split(r"\s+ORDER\s+BY\s+", jql, flags=re.I)[0]
    found = list(issues)
    for clause in re.split(r"\s+AND\s+", text.strip(), flags=re.I):
        clause = clause.strip()
        m = re.match(r"^project\s*=\s*(\S+)$", clause, re.I)
        if m:
            found = [i for i in found if str(i.get("key", "")).startswith(m.group(1).strip('"') + "-")]
            continue
        m = re.match(r"^status\s*=\s*(?:\"([^\"]*)\"|(\S+))$", clause, re.I)
        if m:
            want = m.group(1) if m.group(1) is not None else m.group(2)
            found = [i for i in found if ((i.get("fields") or {}).get("status") or {}).get("name") == want]
            continue
        m = re.match(r"^labels\s*=\s*(?:\"([^\"]*)\"|(\S+))$", clause, re.I)
        if m:
            want = m.group(1) if m.group(1) is not None else m.group(2)
            found = [i for i in found if want in ((i.get("fields") or {}).get("labels") or [])]
            continue
        if re.match(r"^sprint\s+in\s+openSprints\(\)$", clause, re.I):
            found = [i for i in found if any(isinstance(sp, dict) and sp.get("state") == "active"
                                             for sp in (i.get("fields") or {}).get(SPRINT_FIELD) or [])]
            continue
        if re.fullmatch(r"flagged\s+is\s+empty", clause, re.I):
            found = [i for i in found if not (i.get("fields") or {}).get(FLAG_FIELD)]
            continue
        m = re.match(r"^issuetype\s+in\s*\(([^)]*)\)$", clause, re.I)
        if m:
            names = [n.strip().strip('"') for n in m.group(1).split(",")]
            found = [i for i in found if ((i.get("fields") or {}).get("issuetype") or {}).get("name") in names]
            continue
        return None
    return found


class FileTransport:
    """Same call shape as the real transport: (method, url, headers, body) -> (status, body bytes, headers)."""

    def __init__(self, folder: Path):
        self.folder = folder

    def _load(self) -> dict:
        try:
            state = json.loads((self.folder / MARKER).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            state = {}
        for name, empty in (("issues", {}), ("comments", {}), ("properties", {}), ("changelogs", {}), ("next_id", 1),
                            ("tick", 0)):
            state.setdefault(name, empty)
        return state

    def _save(self, state: dict) -> None:
        tmp = self.folder / (MARKER + ".tmp")
        tmp.write_text(json.dumps(state), encoding="utf-8")
        os.replace(str(tmp), str(self.folder / MARKER))

    def __call__(self, method: str, url: str, headers: Dict[str, str], body: Optional[bytes]) -> Tuple[int, bytes, dict]:
        path = url.split("atlassian.net", 1)[1] if "atlassian.net" in url else url
        data = json.loads(body) if body else None
        with open(str(self.folder / CALLS), "a", encoding="utf-8") as log:
            log.write(json.dumps({"method": method, "path": path, "body": data}) + "\n")
        state = self._load()
        rules = jira_strict.load(self.folder)
        if rules is None:
            status, payload = self._handle(state, method, path, data)
        else:
            status, payload = self._strict(rules, state, method, path, data)
        self._save(state)
        return status, (json.dumps(payload).encode() if payload is not None else b""), {}

    @staticmethod
    def _now(state: dict) -> str:
        """A timestamp that moves forward by a minute with every call that asks for one (tests set `clock` to start)."""
        state["tick"] += 1
        start = datetime.strptime(state.get("clock", "2026-11-17T12:00:00"), "%Y-%m-%dT%H:%M:%S")
        return (start + timedelta(minutes=state["tick"])).strftime("%Y-%m-%dT%H:%M:%S.000+0000")

    def _log_change(self, state: dict, key: str, field: str, before=None, after=None) -> None:
        state["changelogs"].setdefault(key, []).append({
            "created": self._now(state), "author": {"accountId": state.get("myself", "acct-josh")},
            "items": [{"field": field, "fromString": before, "toString": after}]})

    def _strict(self, rules, state: dict, method: str, path: str, data: Optional[dict]):
        """The same calls, judged against JP's snapshot first (jira_strict.Rules); what passes goes to _handle."""
        bare = path.split("?")[0]
        parts = bare.strip("/").split("/")
        issues = state["issues"]
        if method == "POST" and bare == "/rest/api/3/issue":
            problem = rules.check_create(data)
            if problem:
                return 400, problem
            status, payload = self._handle(state, method, path, data)
            fields = issues[payload["key"]]["fields"]
            fields["status"] = rules.initial()
            fields["issuetype"] = rules.wire_type(rules.issue_type(fields["issuetype"]))
            return status, payload
        if method == "POST" and bare == "/rest/api/3/search/jql":
            problem = rules.check_jql((data or {}).get("jql") or "")
            if problem:
                return 400, problem
            status, payload = self._handle(state, method, path, data)
            for issue in (payload or {}).get("issues") or []:
                problem = rules.dress(issue)
                if problem:
                    return 500, jira_strict.refusal(messages=[problem])
            return status, payload
        if method == "GET" and bare == "/rest/api/3/issue/createmeta/{}/issuetypes".format(rules.project["key"]):
            return 200, rules.createmeta()
        if method == "GET" and bare == "/rest/api/3/issueLinkType":
            return 200, rules.link_types()
        if method == "POST" and bare == "/rest/api/3/issueLink":
            problem = rules.check_link(data)
            if problem:
                return 404, problem
            for side in ("outwardIssue", "inwardIssue"):
                if ((data or {}).get(side) or {}).get("key") not in issues:
                    return 404, jira_strict.refusal(messages=["Issue does not exist or you do not have permission "
                                                              "to see it."])
            return self._handle(state, method, path, data)
        if parts[:4] == ["rest", "api", "3", "issue"] and len(parts) >= 5:
            if parts[4] not in issues:
                return 404, jira_strict.refusal(messages=["Issue does not exist or you do not have permission to see it."])
            issue = issues[parts[4]]
            if method == "GET" and len(parts) == 5:
                copy = json.loads(json.dumps(issue))
                problem = rules.dress(copy)
                return (500, jira_strict.refusal(messages=[problem])) if problem else (200, copy)
            if method == "PUT" and len(parts) == 5:
                problem = rules.check_edit(issue, data)
                return (400, problem) if problem else self._handle(state, method, path, data)
            if parts[5:] == ["transitions"]:
                current = (issue["fields"].get("status") or {}).get("name") or ""
                if method == "GET":
                    return 200, {"transitions": rules.transitions_from(current)}
                if method == "POST":
                    problem, target = rules.check_transition(issue, data)
                    if problem:
                        return 400, problem
                    issue["fields"].update((data or {}).get("fields") or {})
                    issue["fields"]["status"] = target
                    self._log_change(state, parts[4], "status", current, target["name"])
                    return 204, None
        return self._handle(state, method, path, data)

    def _handle(self, state: dict, method: str, path: str, data: Optional[dict]):
        bare = path.split("?")[0]
        parts = bare.strip("/").split("/")
        issues, comments, props = state["issues"], state["comments"], state["properties"]
        if method == "POST" and bare == "/rest/api/3/issue":
            key = "JP-{}".format(200 + state["next_id"])
            state["next_id"] += 1
            fields = dict(data["fields"], status={"name": "Not Started"}, issuelinks=[])
            issues[key] = {"key": key, "fields": fields}
            for prop in data.get("properties", []):
                props["{}|{}".format(key, prop["key"])] = prop["value"]
            return 201, {"key": key}
        if method == "POST" and bare == "/rest/api/3/search/jql":
            if state.get("search_fails"):
                return 500, {}
            if state.get("apply_jql"):
                found = _judge(list(issues.values()), (data or {}).get("jql") or "")
                if found is None:
                    return 400, {"errorMessages": ["the fake cannot judge this JQL"]}
                return 200, {"issues": found[: int((data or {}).get("maxResults") or 100)], "isLast": True}
            return 200, {"issues": list(issues.values()), "isLast": True}
        if method == "GET" and parts[:4] == ["rest", "api", "3", "issue"] and len(parts) == 5:
            return (200, issues[parts[4]]) if parts[4] in issues else (404, {})
        if method == "POST" and parts[-1] == "comment":
            cid = str(state["next_id"])
            state["next_id"] += 1
            comments.setdefault(parts[4], []).append({"id": cid, "body": data["body"], "created": self._now(state)})
            return 201, {"id": cid}
        if method == "GET" and len(parts) == 7 and parts[5] == "comment":
            for row in comments.get(parts[4], []):
                if row["id"] == parts[6]:
                    return 200, row
            return 404, {}
        if method == "GET" and parts[-1] == "comment":
            rows = [dict({"author": {"displayName": "Josh"}, "created": "2026-11-17T00:00:00.000+0000"}, **r)
                    for r in comments.get(parts[4], [])]
            return 200, {"comments": rows, "total": len(rows)}
        if method == "PUT" and parts[5:6] == ["properties"]:
            props["{}|{}".format(parts[4], parts[6])] = data
            return 200, None
        if method == "GET" and parts[5:6] == ["properties"]:
            name = "{}|{}".format(parts[4], parts[6])
            return (200, {"key": parts[6], "value": props[name]}) if name in props else (404, {})
        if method == "PUT" and len(parts) == 5 and parts[4] in issues:
            for name in (data.get("fields") or {}):
                if name == "description":
                    self._log_change(state, parts[4], "description")
            issues[parts[4]]["fields"].update(data.get("fields") or {})
            return 204, None
        if method == "GET" and parts[-1] == "transitions":
            names = state.get("statuses") or ["Not Started", "Ready", "In Progress", "Done"]
            return 200, {"transitions": [{"id": "21", "to": {"name": "In Progress"}}]
                         + [{"id": "t:" + n, "to": {"name": n}} for n in names]}
        if method == "POST" and parts[-1] == "transitions":
            wanted = data["transition"]["id"]
            name = "In Progress" if wanted == "21" else wanted[2:]
            before = (issues[parts[4]]["fields"].get("status") or {}).get("name")
            issues[parts[4]]["fields"]["status"] = {"name": name}
            self._log_change(state, parts[4], "status", before, name)
            return 204, None
        if method == "GET" and bare == "/rest/api/3/myself":
            return 200, {"accountId": state.get("myself", "acct-josh")}
        if method == "GET" and parts[-1] == "changelog":
            rows = [dict(r, author=r["author"]) for r in state["changelogs"].get(parts[4], [])]
            return 200, {"values": rows, "total": len(rows), "isLast": True}
        if method == "GET" and bare == "/rest/api/3/issueLinkType":
            return 200, {"issueLinkTypes": [{"name": "Blocks", "inward": "is blocked by", "outward": "blocks"},
                                            {"name": "Relates", "inward": "relates to", "outward": "relates to"}]}
        if method == "POST" and bare == "/rest/api/3/issueLink":
            link = {"type": {"name": data["type"]["name"]}, "outwardIssue": data["inwardIssue"]}
            issues[data["outwardIssue"]["key"]]["fields"]["issuelinks"].append(link)
            return 201, None
        return 500, {}
