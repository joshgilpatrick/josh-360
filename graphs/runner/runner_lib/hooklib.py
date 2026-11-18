"""The logic of the four hooks that put the rails on a graph step's session (JP-117). Python 3.9, standard library only.

The hook files in `hooks/<Event>/20-graph-step*` are thin wrappers that call `main(event)`; tests call the functions in
process. Every function takes the event's JSON payload, the environment and the time, and returns a `Result`: the exit
code (0 carry on, 2 block), what to print on standard output and what to print on standard error. A session with no
entry file in `graph-sessions/` is not a graph session, and every function returns `(0, "", "")` for it before reading
anything else: the rails act on the runner's sessions and on no other.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Callable, Dict, Optional, Tuple

from . import paths, sessionfile
from ledger import graph_sessions, spool  # noqa: E402
from walker_lib import runfolder  # noqa: E402

Result = Tuple[int, str, str]
NOTHING: Result = (0, "", "")
MARKER = re.compile(r"^\[josh360-step run=(r-[0-9a-z]+) step=([a-z0-9_]+) attempt=([0-9]+) key=([0-9a-f]{16})\]\s*$", re.M)
Unreadable = sessionfile.Unreadable


def marker(run: str, step: str, attempt: int, key: str) -> str:
    return "[josh360-step run={} step={} attempt={} key={}]".format(run, step, attempt, key)


def _write(path: Path, doc: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(doc, sort_keys=True), encoding="utf-8")
    os.replace(str(tmp), str(path))


def entry(session_id: object) -> Optional[dict]:
    """The session's graph-session entry; None when it has none; Unreadable when the file is there and cannot be read."""
    try:
        path = graph_sessions.entry_path(session_id)   # type: ignore[arg-type]
    except ValueError:
        return None
    if not path.is_file():
        return None
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as err:
        raise Unreadable("{}: {}".format(path.name, err))
    if not isinstance(doc, dict):
        raise Unreadable("{} is not an object".format(path.name))
    return doc


def link(payload: dict, environ: dict, now: float) -> Result:
    """Make this session a graph session when its first prompt carries the runner's marker for an unlinked step."""
    session_id = payload.get("session_id")
    prompt = payload.get("prompt")
    if not isinstance(session_id, str) or not spool.SESSION_ID.match(session_id) or not isinstance(prompt, str):
        return NOTHING
    found = MARKER.search(prompt)
    if not found:
        return NOTHING
    if graph_sessions.entry_path(session_id).exists():
        return NOTHING
    run, step, attempt, key = found.group(1), found.group(2), int(found.group(3)), found.group(4)
    try:
        folder = runfolder.folder(run)
    except ValueError:
        return NOTHING
    if not folder.is_dir():
        return NOTHING
    doc = sessionfile.read(run, step, attempt)
    if not doc or doc.get("state") not in sessionfile.LIVE or doc.get("key") != key:
        return NOTHING
    if sessionfile.link_path(run, step, attempt).exists():
        return NOTHING
    am_session = environ.get("AGENT_MANAGER_SESSION_ID") or None
    _write(sessionfile.link_path(run, step, attempt), {"session_id": session_id, "am_session": am_session, "linked_at": now})
    keys = ("run", "step", "attempt", "graph", "ticket", "access", "tier", "outcomes", "result_file", "work_dir")
    made = {k: doc.get(k) for k in keys}
    made.update(run_folder=str(folder), started_at=now, am_session=am_session, nudged_at=None)
    _write(graph_sessions.entry_path(session_id), made)
    return NOTHING


FUNCTIONS: Dict[str, Callable[[dict, dict, float], Result]] = {"UserPromptSubmit": link}


def main(event: str) -> int:
    """What a hook file calls: read the payload, run the event's function, print its result, return the exit code.
    An exception exits 2 when the session has an entry file (a graph session is denied, not waved through) and 0
    when it has none."""
    session_id = None
    try:
        payload = json.loads(sys.stdin.read())
        session_id = payload.get("session_id") if isinstance(payload, dict) else None
        function = FUNCTIONS.get(event)
        if function is None or not isinstance(payload, dict):
            return 0
        code, out, err = function(payload, dict(os.environ), time.time())
        if out:
            sys.stdout.write(out)
        if err:
            sys.stderr.write(err)
        return code
    except Exception as exc:  # noqa: BLE001
        if graph_sessions.is_graph_session(session_id):
            sys.stderr.write("graph step hook failed ({}): this session's rails could not be checked\n".format(
                type(exc).__name__))
            return 2
        return 0
