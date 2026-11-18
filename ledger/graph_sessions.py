"""Where a graph session's link lives (JP-117). Python 3.9, standard library only.

The runner's link hook writes `<state>/graph-sessions/<Claude Code session id>.json` when a session's first prompt
carries the runner's marker. The other three rail hooks read it, and so do the ledger's hooks, which stay quiet in a
graph session: it has its ticket by construction and gets its comments through the run's folder.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from ledger import _repo  # noqa: E402,F401
from laptop import common  # noqa: E402
from ledger import spool  # noqa: E402


def folder() -> Path:
    return common.state_dir() / "graph-sessions"


def entry_path(session_id: str) -> Path:
    if not isinstance(session_id, str) or not spool.SESSION_ID.match(session_id):
        raise ValueError("not a session id")
    return folder() / (session_id + ".json")


def is_graph_session(session_id: object) -> bool:
    """True when the session has an entry file. Never raises."""
    try:
        return entry_path(session_id).is_file()   # type: ignore[arg-type]
    except Exception:  # noqa: BLE001
        return False
