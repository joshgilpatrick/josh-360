"""The shared Jira client for gate scripts (JP-121; JP-122 and JP-123 use it as it is).

Jira Cloud REST v3 over urllib. Python 3.9, standard library only: gate scripts run on the laptop. Credentials are
JOSH360_JIRA_EMAIL and JOSH360_JIRA_TOKEN (the walker supplies them to gate scripts; never a role session).

The rules every method keeps:

- ``None`` means unknown, never empty (the action-triage#88 rule). A read that fails returns ``None``; a list of
  zero rows is a real answer.
- A write reports success only after Jira confirms it, and only a read-back counts for a comment, a transition, a
  link, a property and a flag. ``create`` returns the new key, or ``None`` when Jira did not confirm: the ticket may
  exist, so the caller searches for it and never retries blind.
- Text written to Jira first passes ``patient_data.scan(..., external=True)``. A problem raises
  ``PatientDataRefused`` naming the kinds, never the text, and sends nothing.
- The token never appears in an error, a log line or a return value.

    jira = Jira.from_env()
    issue = jira.get("JP-121")         # {"key", "summary", "status", "description", "labels", ...} or None
    jira.comment("JP-121", "text")      # True only when the comment reads back
"""
from __future__ import annotations

import base64
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Callable, Dict, List, Optional, Tuple

from lib import adf, gate_io, patient_data  # the gate's own folder (graphs/gates) is on sys.path

DEFAULT_SITE = "https://eventuswh-analytics.atlassian.net"
FLAG_FIELD = "customfield_10021"  # "Flagged" (action-triage's ticket list reads the same id)
FLAG_VALUE = "Impediment"
TIMEOUT = 30
MAX_TRIES = 3  # a 429 is retried twice
# transport(method, url, headers, body) -> (status, body bytes, response headers); raises when no answer came.
Transport = Callable[[str, str, Dict[str, str], Optional[bytes]], Tuple[int, bytes, Dict[str, str]]]


class JiraError(Exception):
    """Jira refused a request outright (a 4xx other than a rate limit). The text is Jira's own message."""

    def __init__(self, message: str, status: int = 0):
        super().__init__(message)
        self.status = status


class PatientDataRefused(JiraError):
    """The text carries a patient identifier shape. kinds names them; nothing was sent."""

    def __init__(self, kinds: List[str]):
        super().__init__("patient data screen refused the write: " + ", ".join(kinds))
        self.kinds = kinds


def urllib_transport(method: str, url: str, headers: Dict[str, str], body: Optional[bytes]):
    request = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            return response.status, response.read(), dict(response.headers)
    except urllib.error.HTTPError as err:
        return err.code, err.read(), dict(err.headers)


def _clamp_retry_after(value: Optional[str]) -> float:
    try:
        return min(30.0, max(1.0, float(value)))
    except (TypeError, ValueError):
        return 1.0


class Jira:
    def __init__(self, site: str, email: str, token: str, transport: Optional[Transport] = None,
                 sleep: Callable[[float], None] = time.sleep):
        self.site = site.rstrip("/")
        self._auth = "Basic " + base64.b64encode(f"{email}:{token}".encode("utf-8")).decode("ascii")
        self._transport = transport or urllib_transport
        self._sleep = sleep

    @classmethod
    def from_env(cls, environ: Optional[dict] = None, **kwargs) -> "Jira":
        env = os.environ if environ is None else environ
        from lib import jira_fake  # tests only: a folder-backed Jira, honoured when its marker file exists

        fake = jira_fake.folder_from(env)
        if fake is not None and "transport" not in kwargs:
            kwargs["transport"] = jira_fake.FileTransport(fake)
            return cls(env.get("JOSH360_JIRA_SITE") or DEFAULT_SITE, "test@example.com", "fake-token", **kwargs)
        email = env.get("JOSH360_JIRA_EMAIL") or env.get("ACTION_AGENT_JIRA_EMAIL")
        token = env.get("JOSH360_JIRA_TOKEN")
        if not email or not token:
            gate_io.fail("Jira credentials missing: set JOSH360_JIRA_EMAIL and JOSH360_JIRA_TOKEN")
        return cls(env.get("JOSH360_JIRA_SITE") or DEFAULT_SITE, email, token, **kwargs)

    # -- transport ---------------------------------------------------------------------------------------------

    def _call(self, method: str, path: str, body: Optional[object] = None,
              params: Optional[dict] = None) -> Optional[Tuple[int, object]]:
        """(status, parsed JSON or None), or None when no answer came (timeout, network). Retries a 429 up to
        MAX_TRIES times, honouring Retry-After (1 to 30 s)."""
        url = self.site + path + ("?" + urllib.parse.urlencode(params) if params else "")
        headers = {"Authorization": self._auth, "Accept": "application/json"}
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode("utf-8")
        for attempt in range(MAX_TRIES):
            try:
                status, raw, reply = self._transport(method, url, headers, data)
            except Exception:  # a timeout or a dropped connection; the type's name only, never the request
                return None
            if status == 429 and attempt < MAX_TRIES - 1:
                self._sleep(_clamp_retry_after({k.lower(): v for k, v in (reply or {}).items()}.get("retry-after")))
                continue
            return status, self._parse(raw)
        return None

    @staticmethod
    def _parse(raw: bytes) -> Optional[object]:
        if not raw:
            return None
        try:
            return json.loads(raw.decode("utf-8"))
        except ValueError:
            return None

    @staticmethod
    def _message(parsed: Optional[object]) -> str:
        if isinstance(parsed, dict):
            errors = [str(e) for e in parsed.get("errorMessages") or []]
            errors += [f"{k}: {v}" for k, v in (parsed.get("errors") or {}).items()]
            if errors:
                return "; ".join(errors)[:300]
        return "no detail"

    def _ok(self, result: Optional[Tuple[int, object]], what: str) -> Optional[object]:
        """The parsed body of a 2xx, or None when the answer is unknown (no answer, 429, 5xx). A 4xx raises."""
        if result is None:
            return None
        status, parsed = result
        if 200 <= status < 300:
            return parsed if parsed is not None else {}
        if status in (429,) or status >= 500:
            return None
        raise JiraError(f"{what}: Jira answered {status} ({self._message(parsed)})", status)

    # -- the patient-data screen -------------------------------------------------------------------------------

    @staticmethod
    def screen_text(*texts: Optional[str]) -> None:
        """Raise PatientDataRefused when any text would take a patient identifier to Jira."""
        kinds = sorted({k for t in texts if t for k in patient_data.scan(t, None, False, external=True)})
        if kinds:
            raise PatientDataRefused(kinds)

    @classmethod
    def _screen_adf(cls, value) -> None:
        cls.screen_text(value if isinstance(value, str) else adf.to_text(value))

    # -- reads -------------------------------------------------------------------------------------------------

    def search(self, jql: str, fields: Optional[List[str]] = None, limit: int = 100) -> Optional[List[dict]]:
        """Issues matching the JQL, each as the raw Jira issue, up to limit. None when Jira could not answer."""
        issues: List[dict] = []
        token = None
        while len(issues) < limit:
            body = {"jql": jql, "fields": fields or ["summary", "status"], "maxResults": min(100, limit - len(issues))}
            if token:
                body["nextPageToken"] = token
            parsed = self._ok(self._call("POST", "/rest/api/3/search/jql", body), "search")
            if not isinstance(parsed, dict):
                return None
            issues.extend(parsed.get("issues") or [])
            token = parsed.get("nextPageToken")
            if not token or parsed.get("isLast"):
                break
        return issues[:limit]

    @staticmethod
    def _summarise(raw: dict) -> dict:
        fields = raw.get("fields") or {}
        status = fields.get("status") or {}
        parent = fields.get("parent") or {}
        return {
            "key": raw.get("key"),
            "summary": fields.get("summary") or "",
            "status": status.get("name") or "",
            "status_category": ((status.get("statusCategory") or {}).get("key")) or "",
            "issuetype": (fields.get("issuetype") or {}).get("name") or "",
            "labels": list(fields.get("labels") or []),
            "parent": parent.get("key"),
            "description": adf.plain(fields.get("description")) if isinstance(fields.get("description"), dict)
            else str(fields.get("description") or ""),
            "flagged": bool(fields.get(FLAG_FIELD)),
            "links": fields.get("issuelinks") or [],
            "created": fields.get("created") or "",
            "fields": fields,
        }

    def get(self, key: str, fields: Optional[List[str]] = None) -> Optional[dict]:
        """One ticket as {"key", "summary", "status", "status_category", "issuetype", "labels", "parent",
        "description" (plain text), "flagged", "links", "created", "fields"}; None when unknown or missing."""
        wanted = fields or ["summary", "status", "issuetype", "labels", "parent", "description", "issuelinks",
                            "created", FLAG_FIELD]
        try:
            parsed = self._ok(self._call("GET", f"/rest/api/3/issue/{key}", params={"fields": ",".join(wanted)}),
                              "get " + key)
        except JiraError:
            return None
        return self._summarise(parsed) if isinstance(parsed, dict) and parsed.get("key") else None

    def comments(self, key: str) -> Optional[List[dict]]:
        """The ticket's comments, oldest first, as {"id", "author", "body" (plain text), "created"}."""
        out: List[dict] = []
        start = 0
        while True:
            try:
                parsed = self._ok(self._call("GET", f"/rest/api/3/issue/{key}/comment",
                                             params={"startAt": start, "maxResults": 100}), "comments " + key)
            except JiraError:
                return None
            if not isinstance(parsed, dict):
                return None
            rows = parsed.get("comments") or []
            for row in rows:
                body = row.get("body")
                out.append({"id": row.get("id"), "author": (row.get("author") or {}).get("displayName") or "",
                            "created": row.get("created") or "",
                            "body": adf.plain(body) if isinstance(body, dict) else str(body or "")})
            start += len(rows)
            if not rows or start >= int(parsed.get("total") or 0):
                return out

    def get_property(self, key: str, name: str):
        """The issue property's value, or None when it is not set or unknown."""
        try:
            parsed = self._ok(self._call("GET", f"/rest/api/3/issue/{key}/properties/{name}"), "property")
        except JiraError:
            return None
        return parsed.get("value") if isinstance(parsed, dict) else None

    def exists(self, key: str) -> Optional[bool]:
        """True when the ticket exists, False when Jira says it does not (404), None when the answer is unknown."""
        try:
            parsed = self._ok(self._call("GET", f"/rest/api/3/issue/{key}", params={"fields": "summary"}), "exists")
        except JiraError as err:
            return False if err.status == 404 else None
        return True if isinstance(parsed, dict) and parsed.get("key") else None

    def myself(self) -> Optional[str]:
        """The accountId of the account the credentials belong to. None when unknown."""
        try:
            parsed = self._ok(self._call("GET", "/rest/api/3/myself"), "myself")
        except JiraError:
            return None
        account = parsed.get("accountId") if isinstance(parsed, dict) else None
        return account or None

    def changelog(self, key: str) -> Optional[List[dict]]:
        """Every change to the ticket, oldest first, as {"created", "author" (accountId), "items": [{"field",
        "fieldId", "from", "to"}]}. None when any page could not be read (a half-read history is unknown)."""
        out: List[dict] = []
        start = 0
        while True:
            try:
                parsed = self._ok(self._call("GET", f"/rest/api/3/issue/{key}/changelog",
                                             params={"startAt": start, "maxResults": 100}), "changelog " + key)
            except JiraError:
                return None
            if not isinstance(parsed, dict):
                return None
            rows = parsed.get("values") or []
            for row in rows:
                out.append({"created": row.get("created") or "",
                            "author": (row.get("author") or {}).get("accountId") or "",
                            "items": [{"field": i.get("field") or "", "fieldId": i.get("fieldId") or "",
                                       "from": i.get("fromString") if i.get("fromString") is not None else i.get("from"),
                                       "to": i.get("toString") if i.get("toString") is not None else i.get("to")}
                                      for i in row.get("items") or []]})
            start += len(rows)
            if not rows or parsed.get("isLast") or start >= int(parsed.get("total") or 0):
                return out

    def read_property(self, key: str, name: str) -> Tuple[str, object]:
        """("set", value), ("unset", None) when Jira says the property does not exist, or ("unknown", None).
        get_property cannot tell the last two apart; use this where an unknown must not be read as unset."""
        try:
            parsed = self._ok(self._call("GET", f"/rest/api/3/issue/{key}/properties/{name}"), "property")
        except JiraError as err:
            return ("unset", None) if err.status == 404 else ("unknown", None)
        if not isinstance(parsed, dict):
            return "unknown", None
        return "set", parsed.get("value")

    def read_json(self, path: str, params: Optional[dict] = None, body: Optional[dict] = None) -> Optional[object]:
        """A raw read for tools such as scripts/jira_snapshot.py: the parsed body, None when unknown; a 4xx raises.
        `body` is only for the search endpoint, which Jira reads with a POST."""
        return self._ok(self._call("POST" if body is not None else "GET", path, body, params), "read " + path)

    def create_meta(self, project: str) -> Optional[Dict[str, str]]:
        """{issue type name: id} for a project, from Jira's create metadata. None when unknown."""
        try:
            parsed = self._ok(self._call("GET", f"/rest/api/3/issue/createmeta/{project}/issuetypes"), "createmeta")
        except JiraError:
            return None
        if not isinstance(parsed, dict):
            return None
        rows = parsed.get("issueTypes") or parsed.get("values")
        if rows is None:
            return None
        return {r.get("name"): r.get("id") for r in rows if r.get("name")}

    # -- writes ------------------------------------------------------------------------------------------------

    def create(self, fields: dict, properties: Optional[dict] = None) -> Optional[str]:
        """One create with every field and issue property. The new key, or None when Jira did not confirm (the
        ticket may exist: search for it, never retry blind). A refusal (4xx) raises JiraError."""
        description = fields.get("description")
        self.screen_text(fields.get("summary"), adf.plain(description) if isinstance(description, dict) else description)
        body: dict = {"fields": fields}
        if properties:
            body["properties"] = [{"key": k, "value": v} for k, v in properties.items()]
            self.screen_text(json.dumps(properties))
        parsed = self._ok(self._call("POST", "/rest/api/3/issue", body), "create")
        key = parsed.get("key") if isinstance(parsed, dict) else None
        return key or None

    def comment(self, key: str, body) -> bool:
        """Post a comment (plain text or an ADF document). True only when it reads back."""
        document = adf.paragraphs(body) if isinstance(body, str) else body
        self._screen_adf(document)
        parsed = self._ok(self._call("POST", f"/rest/api/3/issue/{key}/comment", {"body": document}), "comment")
        comment_id = parsed.get("id") if isinstance(parsed, dict) else None
        if not comment_id:
            return False
        try:
            back = self._ok(self._call("GET", f"/rest/api/3/issue/{key}/comment/{comment_id}"), "comment read-back")
        except JiraError:
            return False
        return isinstance(back, dict) and back.get("id") == comment_id

    def set_description(self, key: str, document: dict) -> bool:
        """Replace the ticket's description (an ADF document). True only when a read-back shows the same text."""
        self._screen_adf(document)
        try:
            self._ok(self._call("PUT", f"/rest/api/3/issue/{key}", {"fields": {"description": document}}),
                     "description")
        except JiraError:
            return False
        after = self.get(key, ["description"])
        return after is not None and after["description"] == adf.plain(document)

    def transition(self, key: str, status_name: str) -> bool:
        """Move the ticket to the named status. True only when a read-back shows it there (also when it was
        already there). False when no transition leads there or Jira did not confirm."""
        issue = self.get(key, ["status"])
        if issue is None:
            return False
        want = status_name.strip().casefold()
        if issue["status"].casefold() == want:
            return True
        try:
            parsed = self._ok(self._call("GET", f"/rest/api/3/issue/{key}/transitions"), "transitions")
            options = (parsed or {}).get("transitions") if isinstance(parsed, dict) else None
            match = next((t for t in options or [] if str((t.get("to") or {}).get("name", "")).casefold() == want),
                         None)
            if match is None:
                return False
            self._ok(self._call("POST", f"/rest/api/3/issue/{key}/transitions", {"transition": {"id": match["id"]}}),
                     "transition")
        except JiraError:
            return False
        after = self.get(key, ["status"])
        return after is not None and after["status"].casefold() == want

    def set_flag(self, key: str, on: bool) -> bool:
        """Put the Jira flag on, or take it off. True only when a read-back shows the flag in that state."""
        value = [{"value": FLAG_VALUE}] if on else []
        try:
            self._ok(self._call("PUT", f"/rest/api/3/issue/{key}", {"fields": {FLAG_FIELD: value}}), "flag")
        except JiraError:
            return False
        after = self.get(key, [FLAG_FIELD])
        return after is not None and after["flagged"] == on

    def set_property(self, key: str, name: str, value) -> bool:
        """Set an issue property. True only when it reads back equal."""
        self.screen_text(json.dumps(value))
        try:
            self._ok(self._call("PUT", f"/rest/api/3/issue/{key}/properties/{name}", value), "property")
        except JiraError:
            return False
        return self.get_property(key, name) == value

    def link(self, kind: str, outward: str, inward: str) -> bool:
        """Link two tickets. kind is a link type name ("Blocks", "Relates"); for Blocks, `outward` blocks `inward`.
        True only when the read-back shows the link in that direction (also when it already existed). A link the
        other way round (inward blocks outward) is not this link and is never taken for it."""
        existing = self.get(outward, ["issuelinks"])
        if existing is not None and self._has_link(existing["links"], kind, inward):
            return True
        body = {"type": {"name": kind}, "outwardIssue": {"key": outward}, "inwardIssue": {"key": inward}}
        try:
            self._ok(self._call("POST", "/rest/api/3/issueLink", body), "link")
        except JiraError:
            return False
        after = self.get(outward, ["issuelinks"])
        return after is not None and self._has_link(after["links"], kind, inward)

    def _has_link(self, links: List[dict], kind: str, other: str) -> bool:
        """Does `links` (a ticket's issuelinks) hold `kind` pointing out to `other`? An entry that points in (an
        inwardIssue) is the opposite direction, and counts only for a type that reads the same from both ends."""
        same_kind = [x for x in links if str((x.get("type") or {}).get("name", "")).casefold() == kind.casefold()]
        if any((x.get("outwardIssue") or {}).get("key") == other for x in same_kind):
            return True
        if any((x.get("inwardIssue") or {}).get("key") == other for x in same_kind):
            return self._symmetric(kind)
        return False

    def _symmetric(self, kind: str) -> bool:
        """True when the link type reads the same from both ends ("relates to"). Unknown is not symmetric."""
        try:
            parsed = self._ok(self._call("GET", "/rest/api/3/issueLinkType"), "linktypes")
        except JiraError:
            return False
        rows = parsed.get("issueLinkTypes", []) if isinstance(parsed, dict) else []
        for row in rows:
            if str(row.get("name", "")).casefold() == kind.casefold():
                return bool(row.get("inward")) and row.get("inward") == row.get("outward")
        return False
