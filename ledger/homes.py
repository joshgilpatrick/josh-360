"""Where a session belongs, worked out with no model (JP-107, Task 4). Python 3.9, standard library only.

The order is the design's "How a session finds its home" (docs/design/data-model.md); the first step that answers wins:

  1. branch        the episode's branch starts with a ticket key in a space the registry lists, or a Linear team
  2. ticket-link   the ticket of a run the session did a step for, else the newest trusted ticket link
  3. registry      the episode's folder, then its repository, listed in conventions/registry.json
  4. unassigned    nobody is asked

A home never decides what a session may store (JP-149: every system may hold patient data). The one rule about a
session's own words is `keeps_words`: a folder inside a `.phi` folder stores none.

The ticket's Jira context comes from the injected `jira` callable, so tests run with no network. A failed read is
written as `jira_read = failed` with the ticket kept, and tried again on a later pass; it is never Unassigned.
"""
from __future__ import annotations

import re
import sqlite3
import sys
from pathlib import Path, PurePosixPath
from typing import Callable, Dict, Optional

from ledger import _repo
from ledger.text import short_text

sys.path.insert(0, str(_repo.ROOT / "scripts"))
import conventions as conventions_lib  # noqa: E402  (importing it needs no YAML reader)

TICKET_BRANCH = re.compile(r"^([A-Z][A-Z0-9]+-[0-9]+)([/-]|$)")
# Ticket links the home may rest on. A link whose source is `branch` is the same fact as step 1, so it is not used.
TRUSTED_LINK_SOURCES = ("daemon", "walker", "offer", "josh", "jira-command", "backfill")
RECORDED_BY = "ledger/homes.py"
COMPARED = ("method", "ticket_key", "epic_key", "initiative_key", "area", "system", "priority")


def keeps_words(folder: Optional[str]) -> bool:
    """False only when some part of the folder is `.phi` (Josh's own mark for patient data). The home never decides."""
    if not folder:
        return True
    return not any(part.lower() == ".phi" for part in PurePosixPath(str(folder).replace("\\", "/")).parts)


def _linear_teams(registry: dict) -> Dict[str, dict]:
    return {s["linear_team"]: s for s in registry.get("systems") or [] if s.get("linear_team")}


def _tracker_for(key: str, registry: dict) -> Optional[str]:
    """jira for a key in a space the registry lists, linear for a Linear team key, else None (not a ticket)."""
    prefix = key.rsplit("-", 1)[0]
    if prefix in (registry.get("spaces") or {}):
        return "jira"
    if prefix in _linear_teams(registry):
        return "linear"
    return None


def _system_area(registry: dict, system: Optional[str]) -> Optional[str]:
    for s in registry.get("systems") or []:
        if system and s.get("name") == system:
            return s.get("area")
    return None


def _evidence(text: str) -> str:
    out, _ = short_text(text, 300)
    return out or "none"


def _row(uid: str, episode: dict, method: str, conv: dict, evidence: str, **fields) -> Dict[str, object]:
    row: Dict[str, object] = {
        "session_uid": uid, "episode": episode["episode"], "method": method, "tracker": None, "ticket_key": None,
        "epic_key": None, "initiative_key": None, "area": None, "system": None, "priority": "unassigned",
        "evidence": _evidence(evidence), "conventions_version": conv.get("version") or "unknown",
        "jira_read": "not-needed",
    }
    row.update(fields)
    return row


def _ticket_home(uid: str, episode: dict, method: str, key: str, evidence: str, conv: dict,
                 jira: Callable[[str], Optional[dict]]) -> Dict[str, object]:
    registry, priorities = conv["registry"], conv["priorities"]
    tracker = _tracker_for(key, registry) or "jira"
    if tracker == "linear":
        team = _linear_teams(registry).get(key.rsplit("-", 1)[0], {})
        return _row(uid, episode, method, conv, evidence, tracker="linear", ticket_key=key,
                    system=team.get("name"), area=team.get("area"))  # personal homes wait for JP-132: priority stays unassigned
    context = jira(key)
    if context is None:
        return _row(uid, episode, method, conv, evidence, tracker="jira", ticket_key=key, jira_read="failed")
    system = context.get("system")
    area = context.get("area") or _system_area(registry, system)
    priority = conventions_lib.priority_for(priorities, context.get("epic_key"), context.get("initiative_key"), area)
    return _row(uid, episode, method, conv, evidence, tracker="jira", ticket_key=key, epic_key=context.get("epic_key"),
                initiative_key=context.get("initiative_key"), area=area, system=system, priority=priority,
                jira_read="ok")


def _linked_ticket(conn: sqlite3.Connection, uid: str):
    """(key, evidence) for method 2, or None: a run's ticket first, then the newest trusted link not withdrawn."""
    row = conn.execute(
        """SELECT g.ticket_key, g.run_id FROM step_runs s JOIN graph_runs g ON g.run_id = s.run_id
           WHERE s.session_uid = ? AND g.ticket_key IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM live_corrections c WHERE c.table_name = 'step_runs' AND c.row_id = s.id)
           ORDER BY s.started_at DESC, s.id DESC LIMIT 1""", (uid,)).fetchone()
    if row:
        return row[0], "run {}".format(row[1])
    row = conn.execute(
        """SELECT ticket_key, source, id FROM ticket_links
           WHERE session_uid = ? AND relation = 'touched' AND source IN ({})
             AND NOT EXISTS (SELECT 1 FROM live_corrections c WHERE c.table_name = 'ticket_links' AND c.row_id = ticket_links.id)
           ORDER BY linked_at DESC, id DESC LIMIT 1""".format(",".join("?" * len(TRUSTED_LINK_SOURCES))),
        (uid,) + TRUSTED_LINK_SOURCES).fetchone()
    return (row[0], "link {} from {}".format(row[2], row[1])) if row else None


def find_home(uid: str, episode: dict, conn: sqlite3.Connection, conventions: dict,
              jira: Callable[[str], Optional[dict]]) -> Dict[str, object]:
    """A `session_homes` row (not yet written) for this episode. `episode` has episode, folder, repo and branch;
    `conventions` has registry, priorities, version and home (the folder `~` stands for)."""
    registry = conventions["registry"]
    branch = episode.get("branch") or ""
    match = TICKET_BRANCH.match(branch)
    if match and _tracker_for(match.group(1), registry):
        return _ticket_home(uid, episode, "branch", match.group(1), branch, conventions, jira)
    linked = _linked_ticket(conn, uid)
    if linked and _tracker_for(linked[0], registry):
        return _ticket_home(uid, episode, "ticket-link", linked[0], "{} ({})".format(linked[1], linked[0]),
                            conventions, jira)
    home = conventions.get("home")
    found = None
    if episode.get("folder"):
        found = conventions_lib.lookup_folder(registry, episode["folder"], home=home)
    if (found is None or found["unassigned"]) and episode.get("repo"):
        found = conventions_lib.lookup_repo(registry, episode["repo"])
    if found and not found["unassigned"]:
        return _row(uid, episode, "registry", conventions, "{}: {}".format(found["system"], found["matched"]),
                    system=found["system"], area=found["area"], priority=found["priority"] or "unassigned")
    return _row(uid, episode, "unassigned", conventions, episode.get("folder") or episode.get("repo") or "no folder")


def write_home_if_changed(conn: sqlite3.Connection, row: Dict[str, object], now: str) -> bool:
    """Insert the row unless it says what the session's current home already says. True when a row was written.

    A failed Jira read never replaces a home we already know for the same ticket (it would throw away the epic and
    the priority), and a home written while Jira was down is written again once a read succeeds.
    """
    current = conn.execute("SELECT * FROM current_homes WHERE session_uid = ?", (row["session_uid"],))
    names = [d[0] for d in current.description]
    existing = current.fetchone()
    if existing is not None:
        old = dict(zip(names, existing))
        if row["jira_read"] == "failed" and old["ticket_key"] == row["ticket_key"] and old["method"] == row["method"]:
            return False
        if old["jira_read"] != "failed" or row["jira_read"] == "failed":
            if all(old[k] == row[k] for k in COMPARED):
                return False
    conn.execute(
        """INSERT INTO session_homes (session_uid, episode, method, tracker, ticket_key, epic_key, initiative_key, area,
           system, priority, evidence, conventions_version, jira_read, derived_at, recorded_by)
           VALUES (:session_uid, :episode, :method, :tracker, :ticket_key, :epic_key, :initiative_key, :area, :system,
           :priority, :evidence, :conventions_version, :jira_read, :derived_at, :recorded_by)""",
        dict(row, derived_at=now, recorded_by=RECORDED_BY))
    return True


def load_conventions(version: str, home: str) -> dict:
    """The registry and priorities from their JSON copies (standard library only), as find_home reads them."""
    import json
    folder = _repo.ROOT / "conventions"
    return {"registry": json.loads((folder / "registry.json").read_text(encoding="utf-8")),
            "priorities": json.loads((folder / "priorities.json").read_text(encoding="utf-8")),
            "version": version, "home": home}
