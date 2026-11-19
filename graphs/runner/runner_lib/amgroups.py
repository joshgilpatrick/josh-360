"""Each ticket's Agent Manager sessions (JP-173): their letters, the one kept in view, and its status group.

Python 3.9, standard library only. The runner keeps one file, `<state>/runner/am-tickets.json`, written only here and
only under its lock:

    {"tickets": {"JP-116": {"count": 3, "status": "In Progress", "group": "josh-360/tickets/In Progress",
                            "done_at": null, "sessions": [{"n": 1, "name": "JP-116(a) - Design", "am_session": "...",
                            "run": "...", "step": "design", "attempt": 1, "group": "...", "archived": true}, ...]}}}

`count` is how many sessions the ticket has been given a letter for, across every run and graph, so the next session is
letter `count + 1`. The newest session (the highest `n`) stays unarchived and is filed under the group for the ticket's
status; every earlier one is archived. The status is the one the walker last set on the ticket's newest run
(`jira_status` in its run file, from the graph's `header.jira`), so nothing here reads Jira. A session with no ticket
key is never here. The doctor check `graphs.agent-manager-groups` reads this file and Agent Manager's database.

A session is marked archived or moved only after Agent Manager said yes; a call that failed is tried again on the next
pass. The file holds keys, step names, ids and Agent Manager names only.
"""
from __future__ import annotations

import calendar
import contextlib
import json
import os
import time
from pathlib import Path
from typing import Optional

from . import locks, paths
from ledger import db  # noqa: E402
from walker_lib import runfolder  # noqa: E402

LOCK_WAIT = 120.0
DONE = "Done"


class Busy(Exception):
    """The file's lock stayed held; the caller tries again on its next pass."""


def path() -> Path:
    return paths.state_dir() / "am-tickets.json"


def load() -> dict:
    """The file, or an empty one when it is missing. A file that cannot be read raises ValueError (unknown is not empty)."""
    p = path()
    if not p.is_file():
        return {"tickets": {}}
    try:
        doc = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError) as err:
        raise ValueError("{} cannot be read: {}".format(p, err))
    if not isinstance(doc, dict) or not isinstance(doc.get("tickets"), dict):
        raise ValueError("{} is not a tickets file".format(p))
    return doc


def _save(doc: dict) -> None:
    p = path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_text(json.dumps(doc, indent=1, sort_keys=True), encoding="utf-8")
    os.replace(str(tmp), str(p))


@contextlib.contextmanager
def _locked():
    """The file, loaded under its lock; saved when the block ends without an error."""
    deadline = time.time() + LOCK_WAIT
    while True:
        try:
            with locks.held(paths.state_dir() / "am-tickets.lock"):
                doc = load()
                yield doc
                _save(doc)
                return
        except locks.Held:
            if time.time() >= deadline:
                raise Busy("am-tickets.lock")
            time.sleep(0.2)


def _ticket(doc: dict, key: str) -> dict:
    rec = doc["tickets"].setdefault(key, {})
    rec.setdefault("count", 0)
    rec.setdefault("sessions", [])
    rec.setdefault("status", None)
    rec.setdefault("group", None)
    rec.setdefault("done_at", None)
    return rec


def allocate(key: str) -> int:
    """The ticket's next session number (1 is letter a). Counted once: a spawn retried for the same attempt keeps it."""
    with _locked() as doc:
        rec = _ticket(doc, key)
        rec["count"] = int(rec["count"]) + 1
        return rec["count"]


# -- the ledger and the run files ----------------------------------------------------------------------------------


def _epoch(stamp: object) -> Optional[float]:
    try:
        return float(calendar.timegm(time.strptime(str(stamp), "%Y-%m-%dT%H:%M:%SZ")))
    except ValueError:
        return None


def _newest_run(conn, key: str) -> Optional[dict]:
    row = conn.execute(
        "SELECT g.run_id, e.ended_at FROM graph_runs g LEFT JOIN current_run_ends e ON e.run_id = g.run_id "
        "WHERE g.ticket_key = ? ORDER BY g.started_at DESC, g.id DESC LIMIT 1", (key,)).fetchone()
    return {"run": row[0], "ended_at": row[1]} if row else None


def _run_status(run_id: str) -> Optional[str]:
    try:
        return runfolder.load(run_id).get("jira_status")
    except (FileNotFoundError, ValueError, OSError):
        return None


# -- keeping one session in view -----------------------------------------------------------------------------------


def _place(rec: dict, binding, now: float, keep_days: float) -> None:
    """Archive every session but the newest; file the newest under the ticket's group; archive it 7 days after Done."""
    sessions = sorted(rec["sessions"], key=lambda s: int(s["n"]))
    if not sessions:
        return
    newest = sessions[-1]
    for older in sessions[:-1]:
        if not older.get("archived") and binding.close({"am_session": older["am_session"]}):
            older["archived"] = True
    if newest.get("archived"):
        return
    if rec.get("status") == DONE and rec.get("done_at") is not None and now - float(rec["done_at"]) >= keep_days * 86400:
        if binding.close({"am_session": newest["am_session"]}):
            newest["archived"] = True
        return
    group = rec.get("group")
    if group and newest.get("group") != group and binding.move({"am_session": newest["am_session"]}, group):
        newest["group"] = group


def _set_status(rec: dict, status: Optional[str], ended_at: Optional[str], binding) -> None:
    if status:
        rec["status"] = status
        rec["group"] = binding.ticket_group(status)
    if rec.get("status") == DONE and ended_at is not None:
        if rec.get("done_at") is None:
            rec["done_at"] = _epoch(ended_at)
    else:
        rec["done_at"] = None                              # not Done, or a run is still open: the 7 days start again


def keep(doc: dict, binding, now: float) -> None:
    """A ticket's session has started (or was adopted through its link): note it, archive the ticket's earlier
    sessions, and file it under the ticket's status group. Does nothing for a keyless session or one with no id."""
    key, n = doc.get("ticket"), doc.get("n")
    session = (doc.get("handle") or {}).get("am_session")
    if not key or not n or not session:
        return
    settings = paths.settings()
    with _locked() as data:
        rec = _ticket(data, key)
        if not any(s.get("am_session") == session for s in rec["sessions"]):
            rec["sessions"].append({
                "n": int(n), "name": doc.get("session_name"), "am_session": session, "run": doc.get("run"),
                "step": doc.get("step"), "attempt": doc.get("attempt"),
                "group": (doc.get("handle") or {}).get("group"), "archived": False})
            rec["count"] = max(int(rec["count"]), int(n))
        _set_status(rec, _run_status(doc["run"]) if doc.get("run") else None, None, binding)
        _place(rec, binding, now, float(settings["done_keep_days"]))


def sync(conn, binding, now: float, keys: Optional[list] = None) -> None:
    """For each ticket (all of them, or `keys`): read its newest run's status and end, then place its sessions."""
    settings = paths.settings()
    with _locked() as data:
        for key, rec in sorted(data["tickets"].items()):
            if keys is not None and key not in keys:
                continue
            rec = _ticket(data, key)
            if all(s.get("archived") for s in rec["sessions"]):
                continue
            newest = _newest_run(conn, key)
            if newest is not None:
                _set_status(rec, _run_status(newest["run"]), newest["ended_at"], binding)
            _place(rec, binding, now, float(settings["done_keep_days"]))


def sync_run(run_id: str, binding, now: float) -> None:
    """`sync` for the ticket of one run (the runner calls it after every answer from the walker). Never raises."""
    try:
        doc = runfolder.load(run_id)
        key = doc.get("ticket")
        if not key:
            return
        conn = db.connect(db.ledger_path())
        try:
            sync(conn, binding, now, [key])
        finally:
            conn.close()
    except Exception as err:  # noqa: BLE001  (placing sessions must never stop a run)
        paths.log("advance {}: sessions not placed: {}".format(run_id, type(err).__name__))
