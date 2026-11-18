"""The `no-loose-ends` exit gate's check (JP-161), on JP-109's loose-ends finder. Python 3.9, standard library only.

A run is closed only when the sessions that did its role steps left nothing loose: no unpushed branch, no commits on
no branch, no open pull request, no worktree left behind, no orphaned branch, and no other ticket left short of Done.
The finder (`ledger/loose_ends.py`) is asked about exactly those sessions, plus their subagents, resumes and forks.

Unknown is not empty. The gate stops the run (GateError, exit 1, so `walker.py retry` can run it again) when:
the ledger cannot be read, the run is not in it, a role step has no session recorded, a session has not been
recorded yet for the step it did (the recorder writes a session's refs once it goes quiet), or the finder could
not check something (git, `gh` or Jira did not answer). It answers `loose` with the list when something is loose,
and `pass` when nothing is.

The run's own ticket is neither read nor listed as `ticket-not-done`: where that ticket ends is the graph's to say (triage leaves it
Ready, the other graphs close it before this gate runs). The full list goes to `<run>/work/loose-ends.md`, outside
every repository; the summary the ledger keeps holds counts only.
"""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

from lib.gate_run import GateError

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ledger import loose_ends  # noqa: E402

LIST_FILE = "loose-ends.md"
ABANDONED = "_abandoned"

ROLE_STEPS_SQL = """SELECT r.id, r.step_id, r.attempt, r.started_at, r.session_uid,
  (SELECT x.session_uid FROM step_results x WHERE x.step_run_id = r.id AND x.session_uid IS NOT NULL
   ORDER BY x.version DESC LIMIT 1),
  (SELECT x.outcome FROM step_results x WHERE x.step_run_id = r.id ORDER BY x.version DESC LIMIT 1)
FROM step_runs r WHERE r.run_id = ? AND r.step_kind = 'role' ORDER BY r.id"""
LAST_ACTIVITY_SQL = "SELECT MAX(last_activity_at) FROM current_session_episodes WHERE session_uid = ?"
CHILDREN_SQL = "SELECT child_uid FROM session_lineage WHERE parent_uid = ?"


def run_sessions(conn: sqlite3.Connection, run_id: str) -> Tuple[Optional[str], Set[str], int]:
    """(the run's ticket, its sessions with their subagents, resumes and forks, the cut-off steps with no session).

    GateError when the run is not in the ledger, a role step that ended has no session, or a session has no episode
    yet that covers the step it did."""
    row = conn.execute("SELECT ticket_key FROM graph_runs WHERE run_id = ?", (run_id,)).fetchone()
    if row is None:
        raise GateError("run {} is not in the ledger, so its sessions are unknown".format(run_id))
    ticket = row[0]
    found: Set[str] = set()
    cut_off = 0
    for _, step, attempt, started_at, started_uid, ended_uid, outcome in conn.execute(ROLE_STEPS_SQL, (run_id,)):
        uid = ended_uid or started_uid
        if uid is None:
            if outcome == ABANDONED:
                cut_off += 1   # cut off before any session was named: nothing ran that could leave work behind
                continue
            raise GateError("step {} (attempt {}) has no session recorded, so what it left is unknown".format(
                step, attempt))
        last = conn.execute(LAST_ACTIVITY_SQL, (uid,)).fetchone()[0]
        if last is None or last < started_at:
            raise GateError("the session of step {} (attempt {}) is not recorded yet (the recorder writes it once the "
                            "session goes quiet); retry this gate later".format(step, attempt))
        found.add(uid)
    todo = list(found)
    while todo:   # subagents, resumes and forks, and theirs
        for (child,) in conn.execute(CHILDREN_SQL, (todo.pop(),)).fetchall():
            if child not in found:
                found.add(child)
                todo.append(child)
    return ticket, found, cut_off


def _counts(items: List[dict]) -> str:
    counts: Dict[str, int] = {}
    for item in items:
        counts[item["kind"]] = counts.get(item["kind"], 0) + 1
    return ", ".join("{} {}".format(kind, counts[kind]) for kind in loose_ends.KINDS if kind in counts)


def check(conn: sqlite3.Connection, run_id: str, live, now: str, work_dir: Path) -> Tuple[str, None, str]:
    """`pass` or `loose`, with a summary of counts. Writes the full list to work_dir when something is loose."""
    ticket, uids, cut_off = run_sessions(conn, run_id)
    try:
        result = loose_ends.collect(conn, live, now, sessions=uids, skip_tickets=[ticket] if ticket else [])
    except (sqlite3.Error, ValueError) as exc:
        raise GateError("the loose-ends finder could not read the ledger: {}".format(str(exc)[:120]))
    if result["unchecked"]:
        reasons = "; ".join("{} ({})".format(u["reason"], u["count"]) for u in result["unchecked"])
        raise GateError("could not check everything, and unknown is not clean: " + reasons[:300])
    items = result["items"]
    sessions = "{} session{}".format(len(uids), "" if len(uids) == 1 else "s")
    if cut_off:
        sessions += ", {} cut-off step{} with none".format(cut_off, "" if cut_off == 1 else "s")
    if not items:
        return "pass", None, "nothing is loose ({})".format(sessions)
    result = dict(result, items=items)
    try:
        work_dir.mkdir(parents=True, exist_ok=True)
        (work_dir / LIST_FILE).write_text(
            loose_ends.render_text(result, None, 200, "Loose ends for run " + run_id) + "\n", encoding="utf-8")
    except OSError as exc:
        raise GateError("{} loose end(s) found, but the list could not be written: {}".format(
            len(items), str(exc)[:120]))
    return "loose", None, "{} loose end{} ({}; {}): the list is in work/{}".format(
        len(items), "" if len(items) == 1 else "s", _counts(items), sessions, LIST_FILE)
