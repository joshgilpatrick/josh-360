"""What the walker keeps about a run, read by the triage gates (JP-122). Python 3.9, standard library only.

The run folder (`$JOSH360_RUNS/<run id>/run.json`) says which runs are open and what Josh answered. The ledger says
which session did a step. Both are read, never written.
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
from pathlib import Path
from typing import List, Optional

ROOT = Path(__file__).resolve().parents[4]
GRAPH = "triage"
sys.path.insert(0, str(ROOT))


def runs_dir(environ=None) -> Path:
    env = os.environ if environ is None else environ
    if env.get("JOSH360_RUNS"):
        return Path(env["JOSH360_RUNS"]).absolute()
    return Path(env.get("JOSH360_HOME") or str(Path.home() / ".josh-360")).absolute() / "runs"


def _load(folder: Path) -> Optional[dict]:
    try:
        return json.loads((folder / "run.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def other_open_run(ticket_key: str, environ=None) -> Optional[bool]:
    """True when another triage run on this ticket has not ended; None when the run folders cannot be read."""
    env = os.environ if environ is None else environ
    base = runs_dir(env)
    if not base.exists():
        return False
    try:
        folders = [p for p in base.iterdir() if p.is_dir()]
    except OSError:
        return None
    me = env.get("JOSH360_RUN_ID")
    for folder in folders:
        if folder.name == me:
            continue
        doc = _load(folder)
        if doc and doc.get("graph") == GRAPH and doc.get("ticket") == ticket_key and not doc.get("ended"):
            return True
    return False


def josh_answered(run_id: Optional[str], step: str, environ=None) -> bool:
    """True when Josh answered that ask step in this run (the walker saves the answer as the step's output)."""
    if not run_id:
        return False
    doc = _load(runs_dir(environ) / run_id)
    outputs = ((doc or {}).get("outputs") or {}).get(step) or {}
    return bool(isinstance(outputs, dict) and outputs.get("answer"))


def signing_session(run_id: Optional[str], step: str = "sign_off") -> Optional[str]:
    """The tool session id of the newest run of the sign-off step in this run, from the ledger; None when the step has
    no session recorded or the ledger cannot be read (the caller treats that as "not proven different", never as ok)."""
    if not run_id:
        return None
    try:
        from ledger import db
        conn = db.connect_existing(db.ledger_path())
    except Exception:
        return None
    try:
        row = conn.execute(
            "SELECT s.tool_session_id FROM step_runs r JOIN step_results x ON x.step_run_id = r.id "
            "JOIN sessions s ON s.session_uid = x.session_uid "
            "WHERE r.run_id = ? AND r.step_id = ? ORDER BY r.id DESC, x.version DESC LIMIT 1", (run_id, step)).fetchone()
    except sqlite3.Error:
        return None
    finally:
        conn.close()
    return row[0] if row else None


def prior_round_comments(comments: List[dict], run_id: str) -> int:
    """How many drafter-round notes this run has already posted (the round number is this plus one)."""
    marker = "| run {} |".format(run_id)
    return sum(1 for c in comments if (c.get("body") or "").lstrip().startswith("Triage: revised by the ticket drafter")
               and marker in (c.get("body") or ""))


def answers_count(run_id: Optional[str], step: str, choice: str, environ=None) -> int:
    """How many times Josh chose `choice` at that ask step in this run, from the ledger (the run folder keeps only the
    newest answer, so a second "one more round" would otherwise read as the first). Falls back to the run folder."""
    if not run_id:
        return 0
    try:
        from ledger import db
        conn = db.connect_existing(db.ledger_path())
    except Exception:
        return 1 if josh_answered(run_id, step, environ) else 0
    try:
        row = conn.execute(
            "SELECT COUNT(*) FROM step_runs r JOIN step_results x ON x.step_run_id = r.id "
            "WHERE r.run_id = ? AND r.step_id = ? AND x.outcome = ?", (run_id, step, choice)).fetchone()
        return int(row[0]) if row else 0
    except sqlite3.Error:
        return 1 if josh_answered(run_id, step, environ) else 0
    finally:
        conn.close()
