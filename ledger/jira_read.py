"""One read-only Jira call for the recorder: a ticket's epic, initiative and system (JP-107, Task 4).

This is the only network use in the ledger's code. It runs from the recorder's own process on the laptop, reads and
never writes, and gives up after 10 seconds. A failed read returns None, which the recorder writes as
`jira_read = failed` and tries again on a later pass; it is never turned into Unassigned.

Credentials: the account email from JOSH360_JIRA_EMAIL (or ACTION_AGENT_JIRA_EMAIL, or the one-line file
~/.josh-360/state/jira-email); the token from JOSH360_JIRA_TOKEN, else the macOS keychain item `jira-claude-api-key`
(whatever its account), read with /usr/bin/security (never logged, never put in an error). With no email or no token
every read returns None. Python 3.9, standard library only.
"""
from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Callable, Iterable, Mapping, Optional, Tuple

sys.dont_write_bytecode = True
from ledger import _repo  # noqa: F401,E402
from laptop import common  # noqa: E402

SITE_DEFAULT = "https://eventuswh-analytics.atlassian.net"
KEYCHAIN_SERVICE = "jira-claude-api-key"  # found by name alone: the item's account label has changed before
TIMEOUT_SECONDS = 10
INITIATIVE_SPACE = "TECH"  # initiatives live here; an epic relates to one (conventions/tickets.md)

Fetch = Callable[[str], Optional[dict]]


def email(env: Mapping[str, str], state: Optional[Path] = None) -> str:
    """The account email: JOSH360_JIRA_EMAIL, else ACTION_AGENT_JIRA_EMAIL, else the one-line file
    <state>/jira-email (default ~/.josh-360/state). "" when none is set. Every Jira reader on the laptop uses this."""
    found = env.get("JOSH360_JIRA_EMAIL") or env.get("ACTION_AGENT_JIRA_EMAIL") or ""
    if found:
        return found
    try:
        return ((state or common.state_dir()) / "jira-email").read_text(encoding="utf-8").strip()
    except (OSError, UnicodeDecodeError):
        return ""


def token(env: Mapping[str, str], run: Callable = subprocess.run, timeout: int = 5) -> str:
    """The API token: JOSH360_JIRA_TOKEN, else the keychain item (asked for by name alone). "" when there is none."""
    found = env.get("JOSH360_JIRA_TOKEN") or ""
    if found:
        return found
    try:
        result = run(["/usr/bin/security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, universal_newlines=True, timeout=timeout)
        return result.stdout.strip() if result.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def credentials(env: Mapping[str, str], run: Callable = subprocess.run) -> Optional[Tuple[str, str]]:
    """(email, token) or None when either is missing."""
    found_email = email(env)
    found_token = token(env, run)
    return (found_email, found_token) if found_email and found_token else None


def make_fetch(env: Optional[Mapping[str, str]] = None, urlopen: Callable = urllib.request.urlopen) -> Optional[Fetch]:
    """A GET function for Jira's REST API, or None when there are no credentials."""
    env = os.environ if env is None else env
    creds = credentials(env)
    if creds is None:
        return None
    site = (env.get("JOSH360_JIRA_SITE") or SITE_DEFAULT).rstrip("/")
    auth = "Basic " + base64.b64encode("{}:{}".format(*creds).encode("utf-8")).decode("ascii")

    def fetch(path: str) -> Optional[dict]:
        request = urllib.request.Request(site + path, headers={"Authorization": auth, "Accept": "application/json"})
        try:
            with urlopen(request, timeout=TIMEOUT_SECONDS) as response:
                data = json.loads(response.read().decode("utf-8"))
        except Exception:  # noqa: BLE001  (any failure is "unknown"; the message could hold the header)
            return None
        return data if isinstance(data, dict) else None

    return fetch


def _issue(fetch: Fetch, key: str) -> Optional[dict]:
    return fetch("/rest/api/3/issue/{}?fields=*all&expand=names".format(urllib.parse.quote(key)))


def _type_name(issue: dict) -> str:
    return ((issue.get("fields") or {}).get("issuetype") or {}).get("name") or ""


def _repository(issue: dict) -> Optional[str]:
    """The bare, lower-case repository name from the issue's field named Repository, if it has one."""
    names = issue.get("names") or {}
    for field_id, label in names.items():
        if label == "Repository":
            value = (issue.get("fields") or {}).get(field_id)
            if isinstance(value, dict):
                value = value.get("value") or value.get("name")
            if isinstance(value, str) and value.strip():
                return value.strip().rstrip("/").rsplit("/", 1)[-1].lower().replace("_", "-")
    return None


def _initiative(epic: dict) -> Optional[str]:
    for link in (epic.get("fields") or {}).get("issuelinks") or []:
        for side in ("inwardIssue", "outwardIssue"):
            linked = (link.get(side) or {}).get("key") or ""
            if linked.startswith(INITIATIVE_SPACE + "-"):
                return linked
    return None


def ticket_context(key: str, fetch: Optional[Fetch] = None, system_names: Iterable[str] = ()) -> Optional[dict]:
    """{"epic_key", "initiative_key", "area", "system"} for a ticket, or None when the read failed.

    The epic is the ticket itself when it is an epic, else its parent (two steps up for a subtask); the initiative is
    the TECH ticket the epic links to; the system is the Repository field, else a label that names a system. The
    area is not in Jira: it is None here and the home takes it from the registry. A ticket with no epic returns
    epic_key None (a good read, not a failed one).
    """
    if fetch is None:
        fetch = make_fetch()
    if fetch is None:
        return None
    issue = _issue(fetch, key)
    if issue is None:
        return None
    system = _repository(issue)
    if system is None:
        wanted = {n.lower() for n in system_names}
        for label in (issue.get("fields") or {}).get("labels") or []:
            if isinstance(label, str) and label.lower() in wanted:
                system = label.lower()
                break
    epic = issue if _type_name(issue) == "Epic" else None
    walker = issue
    for _ in range(2):
        if epic is not None:
            break
        parent = ((walker.get("fields") or {}).get("parent") or {}).get("key")
        if not parent:
            break
        walker = _issue(fetch, parent)
        if walker is None:
            return None
        if _type_name(walker) == "Epic":
            epic = walker
    return {"epic_key": epic["key"] if epic is not None else None,
            "initiative_key": _initiative(epic) if epic is not None else None,
            "area": None, "system": system}
