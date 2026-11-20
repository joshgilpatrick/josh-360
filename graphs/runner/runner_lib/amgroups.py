"""Each ticket's Agent Manager sessions (JP-173, JP-191): their letters, the one kept in view, its status group, and
closing a session once its step is finished.

Python 3.9, standard library only. The runner keeps one file, `<state>/runner/am-tickets.json`, written only here and
only under its lock:

    {"tickets": {"JP-116": {"count": 3, "status": "In Progress", "group": "josh-360/tickets/In Progress",
                            "done_at": null, "sessions": [{"n": 1, "name": "JP-116(a) - Design", "am_session": "...",
                            "run": "...", "step": "design", "attempt": 1, "group": "...", "archived": true}, ...]}}}

`count` is how many sessions the ticket has been given a letter for, across every run and graph, so the next session is
letter `count + 1`. A session whose step is still open: the newest (the highest `n`) stays unarchived and is filed under
the group for the ticket's status; every earlier one is archived. A session whose result was recorded (JP-191, its
`finished_at`) is killed (`killed`: the agent stops, the row stays) and filed in `josh-360/completed-steps`
(`filed_at`), which archives it 7 days later; the ticket's last session (`_last`) goes to its status group instead,
and the `close-out` gate is run once for the ticket (`closed_out`). The status is the one the walker last set on the
ticket's newest run (`jira_status` in its run file, from the graph's `header.jira`), so nothing here reads Jira; only the
`close-out` gate, a separate script, does. A session with no ticket key is never here. The doctor checks
`graphs.agent-manager-groups` and `graphs.completed-step-sessions` read this file and Agent Manager's database.

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

from . import locks, paths, sessionfile
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
    rec.setdefault("closed_out", None)
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


# -- keeping one session in view, and closing finished ones (JP-191) ----------------------------------------------


def _last(rec: dict) -> Optional[dict]:
    """The ticket's last session: its newest, once that one's step is finished and the ticket's newest run has ended
    with the ticket in Done (so a ticket in Deployed, still watched, has none). Read from this file alone, never Jira."""
    sessions = sorted(rec["sessions"], key=lambda s: int(s["n"]))
    if not sessions or sessions[-1].get("finished_at") is None:
        return None
    if rec.get("status") != DONE or rec.get("done_at") is None:
        return None
    return sessions[-1]


def _kill(s: dict, binding, now: float, grace: float) -> None:
    """Stop a finished step's agent, keeping its row. At rest, at once; still at work, only `grace` seconds after its
    result was recorded, so a turn that is finishing is not cut off. Gone (dead or archived) needs no call."""
    if s.get("killed"):
        return
    handle = {"am_session": s["am_session"]}
    seen = binding.state(handle)
    if seen == "gone":
        s["killed"] = True
    elif (seen == "resting" or now - float(s["finished_at"]) >= grace) and binding.kill(handle):
        s["killed"] = True


def _archive(s: dict, binding) -> None:
    if binding.close({"am_session": s["am_session"]}):
        s["archived"] = True


def _file(s: dict, group: Optional[str], binding, now: float) -> bool:
    """Move the session to the group (made first if missing); True once it is there."""
    if not group:
        return False
    if s.get("group") != group:
        if not binding.move({"am_session": s["am_session"]}, group):
            return False
        s["group"] = group
        s["filed_at"] = now
    if s.get("filed_at") is None:
        s["filed_at"] = now
    return True


def _finished(s: dict, last: bool, rec: dict, binding, now: float, cfg: dict) -> None:
    """A step whose result is recorded: killed, then filed. The ticket's last session goes to the ticket's status group
    (Done) and leaves `done_keep_days` after the ticket's run ended; any other waits in completed-steps and leaves
    `completed_keep_days` after it was filed there. Nothing is archived before it is killed."""
    _kill(s, binding, now, float(cfg["kill_grace_seconds"]))
    if last:
        if s.get("killed") and now - float(rec["done_at"]) >= float(cfg["done_keep_days"]) * 86400:
            _archive(s, binding)
            return
        _file(s, rec.get("group"), binding, now)
        return
    completed = binding.completed_group()
    if (s.get("killed") and s.get("group") == completed and s.get("filed_at") is not None
            and now - float(s["filed_at"]) >= float(cfg["completed_keep_days"]) * 86400):
        _archive(s, binding)
        return
    _file(s, completed, binding, now)


def _recorded(s: dict) -> None:
    """A session whose result was recorded but whose `finish` never reached this file (its lock was busy, or the
    runner stopped in between): take the time from its session file. Only files written since JP-191 carry `closes`,
    so sessions from before it are never closed."""
    if s.get("finished_at") is not None or not s.get("run") or not s.get("step"):
        return
    try:
        doc = sessionfile.read(s["run"], s["step"], int(s.get("attempt") or 1))
    except (sessionfile.Unreadable, ValueError, OSError):
        return
    if doc and doc.get("state") == "recorded" and doc.get("closes") and doc.get("ended_at") is not None:
        s["finished_at"] = float(doc["ended_at"])


def _place(rec: dict, binding, now: float, cfg: dict) -> None:
    """Close each finished session (`_finished`). Of the others, archive every one but the newest, file the newest
    under the ticket's group, and archive it 7 days after Done (JP-173)."""
    sessions = sorted(rec["sessions"], key=lambda s: int(s["n"]))
    if not sessions:
        return
    for s in sessions:
        if not s.get("archived"):
            _recorded(s)
    newest, last = sessions[-1], _last(rec)
    for s in sessions:
        if s.get("archived"):
            continue
        if s.get("finished_at") is not None:
            _finished(s, s is last, rec, binding, now, cfg)
        elif s is not newest:
            _archive(s, binding)
    if newest.get("archived") or newest.get("finished_at") is not None:
        return
    keep_days = float(cfg["done_keep_days"])
    if rec.get("status") == DONE and rec.get("done_at") is not None and now - float(rec["done_at"]) >= keep_days * 86400:
        _archive(newest, binding)
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
        rec["closed_out"] = None                           # and a later Done closes the ticket out again (JP-191)


def _entry(rec: dict, doc: dict, session: str) -> dict:
    """The ticket's record of this session, added when it is new."""
    for s in rec["sessions"]:
        if s.get("am_session") == session:
            return s
    s = {"n": int(doc["n"]), "name": doc.get("session_name"), "am_session": session, "run": doc.get("run"),
         "step": doc.get("step"), "attempt": doc.get("attempt"), "group": (doc.get("handle") or {}).get("group"),
         "archived": False}
    rec["sessions"].append(s)
    rec["count"] = max(int(rec["count"]), int(doc["n"]))
    return s


def keep(doc: dict, binding, now: float) -> None:
    """A ticket's session has started (or was adopted through its link): note it, archive the ticket's earlier
    sessions, and file it under the ticket's status group. Does nothing for a keyless session or one with no id."""
    _note(doc, binding, now, finished=False)


def finish(doc: dict, binding, now: float) -> None:
    """A ticket's session's result was recorded (JP-191): note when, then kill it and file it in completed-steps (or,
    for the ticket's last session, its status group). Does nothing for a keyless session or one with no id."""
    _note(doc, binding, now, finished=True)


def _note(doc: dict, binding, now: float, finished: bool) -> None:
    key, n = doc.get("ticket"), doc.get("n")
    session = (doc.get("handle") or {}).get("am_session")
    if not key or not n or not session:
        return
    settings = paths.settings()
    with _locked() as data:
        rec = _ticket(data, key)
        s = _entry(rec, doc, session)
        if finished and s.get("finished_at") is None:
            s["finished_at"] = now
        _set_status(rec, _run_status(doc["run"]) if doc.get("run") else None, None, binding)
        _place(rec, binding, now, settings)


# -- closing a finished ticket out (JP-191) ------------------------------------------------------------------------

CLOSE_OUT = "close-out"
CLOSE_OUT_OUTCOMES = ["moved", "already-done", "left"]


def _close_out(key: str, run_id: Optional[str]) -> Optional[str]:
    """Run the `close-out` gate for the ticket (only a gate moves a ticket: graphs/CONVENTION.md, rule 2). The gate
    moves it to Done unless it is there already, or in Deployed (its watch owns it) or Cancelled. Returns its outcome,
    or None when it failed (tried again on the next pass)."""
    from walker_lib import gates   # the walker's own gate runner and Jira credentials
    env = dict(os.environ)
    env.update(gates.jira_env())
    env.update(GRAPH_INPUT_TICKET_KEY=key, JOSH360_TICKET_KEY=key, JOSH360_RUN_ID=run_id or "")
    result = gates.run_gate(paths.ROOT / "graphs", CLOSE_OUT, env, paths.ROOT, CLOSE_OUT_OUTCOMES)
    if result.error:
        paths.log("close-out {}: {}".format(key, result.error[:200]))
        return None
    paths.log("close-out {}: {}".format(key, result.outcome))
    return result.outcome


def _close_outs(conn, keys: list, now: float) -> None:
    """Outside the file's lock (a gate may take a while): close out each ticket, then note it under the lock."""
    for key in keys:
        newest = _newest_run(conn, key)
        outcome = _close_out(key, newest["run"] if newest else None)
        if outcome is None:
            continue
        with _locked() as data:
            rec = _ticket(data, key)
            if _last(rec) is not None:
                rec["closed_out"] = now


def sync(conn, binding, now: float, keys: Optional[list] = None) -> None:
    """For each ticket (all of them, or `keys`): read its newest run's status and end, place its sessions, and close
    out each ticket whose last session has just finished (JP-191)."""
    settings = paths.settings()
    due = []
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
            _place(rec, binding, now, settings)
            if _last(rec) is not None and rec.get("closed_out") is None:
                due.append(key)
    _close_outs(conn, due, now)


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
