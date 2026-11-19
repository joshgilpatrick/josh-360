"""Where an intake item lives, and how to find out whether it may start a run or be linked to a ticket (JP-121).

Python 3.9, standard library only. Every path comes from the environment so tests use made-up files:

    JOSH360_ACTION_ITEMS   action-triage's action-items.json (to-dos and meeting action items)
    DESK_DB                the Email Research Desk's ledger (desk.db), a SQLite file
    JOSH360_RUNS           the walker's run folder (default ~/.josh-360/runs)

    item_state(source, source_ref) -> dict   exists, dismissed, ticket_key, open_run (None means unknown)
    source_text(source, source_ref) -> str   the item's own words, for the patient-data copy check; "" if unknown
    link(source, source_ref, keys)           record the first key on the source item; True when it reads back

A `session` pointer of the form `follow-up:<run id>:<file id>` names a graph step's follow-up (JP-175,
lib/follow_ups.py): its file is its store, and the new key is written back into it.

The input's text is never copied anywhere by this module: callers receive it only to compare against.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
from pathlib import Path
from typing import List, Optional

from lib import follow_ups

FIRST_WAVE = ("email", "todo", "session", "manual")
WITH_STORE = ("email", "todo", "notion")      # a session or a hand-typed request has no store that can carry a key
KEY = re.compile(r"^[A-Z][A-Z0-9]+-[1-9][0-9]*$")
TICKET_REF = re.compile(r"^ticket:([A-Z][A-Z0-9]+-[1-9][0-9]*)$")


def action_items_path() -> Path:
    return Path(os.path.expanduser(os.environ.get("JOSH360_ACTION_ITEMS") or "~/.josh-360/action-items.json"))


def desk_db_path() -> Path:
    default = "~/Library/Application Support/agent-services-desk/desk.db"
    return Path(os.path.expanduser(os.environ.get("DESK_DB") or default))


def runs_dir() -> Path:
    return Path(os.path.expanduser(os.environ.get("JOSH360_RUNS") or "~/.josh-360/runs"))


# -- action items and to-dos ---------------------------------------------------------------------------------------

def _read_items(path: Path) -> Optional[dict]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _find_item(data: dict, item_id: str) -> Optional[dict]:
    lists = list((data.get("items") or {}).values()) + [data.get("todos") or []]
    for rows in lists:
        for row in rows or []:
            if isinstance(row, dict) and row.get("id") == item_id:
                return row
    return None


def _item_ticket_key(item: dict) -> Optional[str]:
    for field in ("ticketKey", "taskId"):
        value = item.get(field)
        if isinstance(value, str):
            match = TICKET_REF.match(value) or (KEY.match(value) and [None, value])
            if match:
                return match[1]
    return None


# -- the desk ------------------------------------------------------------------------------------------------------

def _desk_connect(read_only: bool) -> Optional[sqlite3.Connection]:
    path = desk_db_path()
    if not path.is_file():
        return None
    try:
        uri = f"file:{path}?mode={'ro' if read_only else 'rw'}"
        return sqlite3.connect(uri, uri=True, timeout=10)
    except sqlite3.Error:
        return None


def _desk_thread(source_ref: str) -> Optional[dict]:
    conn = _desk_connect(True)
    if conn is None:
        return None
    try:
        row = conn.execute("SELECT conversation_id, jira_key FROM threads WHERE conversation_id = ? OR row_id = ?",
                           (source_ref, source_ref)).fetchone()
    except sqlite3.Error:
        return None
    finally:
        conn.close()
    return {"conversation_id": row[0], "jira_key": row[1]} if row else {}


# -- runs ----------------------------------------------------------------------------------------------------------

def has_open_run(source: str, source_ref: str) -> Optional[bool]:
    """True when another ticket-creation run on this item has not ended. The walker's run folders record each
    run's inputs in run.json; a run is open until its folder says it ended. None when the folder cannot be read."""
    base = runs_dir()
    if not base.exists():
        return False
    try:
        folders = [p for p in base.iterdir() if p.is_dir()]
    except OSError:
        return None
    me = os.environ.get("JOSH360_RUN_ID")
    for folder in folders:
        if folder.name == me:
            continue
        try:
            doc = json.loads((folder / "run.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        values = doc.get("inputs") or {}
        if doc.get("graph") == "ticket-creation" and not doc.get("ended") \
                and values.get("source") == source and values.get("source_ref") == source_ref:
            return True
    return False


# -- the public functions ------------------------------------------------------------------------------------------

def item_state(source: str, source_ref: str) -> dict:
    state = {"exists": False, "dismissed": False, "ticket_key": None, "open_run": False, "known": True}
    if source in ("todo", "notion"):
        data = _read_items(action_items_path())
        item = _find_item(data, source_ref) if isinstance(data, dict) else None
        state["known"] = data is not None
        if item:
            state.update(exists=True, dismissed=item.get("status") == "dismissed", ticket_key=_item_ticket_key(item))
    elif source == "email":
        thread = _desk_thread(source_ref)
        state["known"] = thread is not None
        if thread:
            state.update(exists=True, ticket_key=thread.get("jira_key") or None)
    elif source == "session" and source_ref.startswith(follow_ups.PREFIX):  # a graph step's follow-up (JP-175)
        doc = follow_ups.load(source_ref)          # None for a pointer that does not parse: no such item
        if doc:
            state.update(exists=True, dismissed=doc.get("state") == "dropped", ticket_key=doc.get("key") or None)
    else:  # a session or a hand-typed request names no store of its own; the pointer is the only record
        state["exists"] = bool(source_ref.strip())
    run = has_open_run(source, source_ref)
    state["open_run"] = bool(run)
    if run is None:
        state["known"] = False
    return state


def source_text(source: str, source_ref: str) -> str:
    """The item's own words, for the copy check. Never stored or printed. Email text stays in the desk's mailbox, so
    for email the check compares against the to-do style text only when the desk exports it; otherwise ""."""
    if source in ("todo", "notion"):
        data = _read_items(action_items_path())
        item = _find_item(data, source_ref) if isinstance(data, dict) else None
        return str(item.get("text") or "") if item else ""
    if source == "session" and follow_ups.parse_ref(source_ref):
        doc = follow_ups.load(source_ref) or {}
        return "{}\n{}".format(doc.get("summary") or "", doc.get("why") or "").strip()
    return ""


def link(source: str, source_ref: str, keys: List[str]) -> bool:
    """Write the first key back to the source item. Idempotent. True when it reads back from the item."""
    if not keys:
        return False
    key = keys[0]
    if source in ("todo", "notion"):
        return _link_item(source_ref, key)
    if source == "email":
        return _link_desk(source_ref, key)
    if source == "session" and follow_ups.parse_ref(source_ref):
        return follow_ups.update(source_ref, key=key, state="filed")
    return True  # a session or a hand-typed request: the key is recorded in the run's own output and the ledger


def _link_item(item_id: str, key: str) -> bool:
    path = action_items_path()
    lock = Path(str(path) + ".lock")
    held = False
    try:
        fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, json.dumps({"pid": os.getpid()}).encode())
        os.close(fd)
        held = True
    except FileExistsError:
        return False  # action-triage holds it; the walker's single retry comes back later
    except OSError:
        return False
    try:
        data = _read_items(path)
        item = _find_item(data, item_id) if isinstance(data, dict) else None
        if item is None:
            return False
        item["ticketKey"] = key
        if item.get("status") == "active":
            item["status"] = "tasked"
        tmp = path.with_name(f".action-items-{os.getpid()}.tmp")
        tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
        os.replace(str(tmp), str(path))
    except OSError:
        return False
    finally:
        if held:
            try:
                lock.unlink()
            except OSError:
                pass
    again = _read_items(path)
    back = _find_item(again, item_id) if isinstance(again, dict) else None
    return bool(back) and _item_ticket_key(back) == key


def _link_desk(source_ref: str, key: str) -> bool:
    conn = _desk_connect(False)
    if conn is None:
        return False
    try:
        with conn:
            cur = conn.execute("UPDATE threads SET jira_key = ? WHERE (conversation_id = ? OR row_id = ?) "
                               "AND (jira_key IS NULL OR jira_key = '' OR jira_key = ?)",
                               (key, source_ref, source_ref, key))
        row = conn.execute("SELECT jira_key FROM threads WHERE conversation_id = ? OR row_id = ?",
                           (source_ref, source_ref)).fetchone()
    except sqlite3.Error:
        return False
    finally:
        conn.close()
    return bool(row) and row[0] == key
