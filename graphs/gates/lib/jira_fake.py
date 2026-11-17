"""A Jira that lives in a folder, for tests that run the real gate scripts as separate processes (JP-121).

It is used only when JOSH360_JIRA_FAKE names a folder that holds a file called fake-jira.json (the marker; an empty
{} is enough). A real laptop never has that folder, so a stray variable cannot turn real writes into fake ones.

State is kept in <folder>/fake-jira.json (issues, comments, properties) and every request is appended to
<folder>/calls.jsonl, so a test can read what was written and in what order. Python 3.9, standard library only.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, Optional, Tuple

MARKER = "fake-jira.json"
CALLS = "calls.jsonl"


def folder_from(environ: dict) -> Optional[Path]:
    value = environ.get("JOSH360_JIRA_FAKE")
    if not value:
        return None
    folder = Path(os.path.expanduser(value))
    return folder if (folder / MARKER).is_file() else None


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
        status, payload = self._handle(state, method, path, data)
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
