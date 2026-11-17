"""The one-time backfill: bring the history that already exists into the ledger (JP-107, Task 9).

Run once by the `ledger-backfill` job (`every: once`), not by the install script, because a pass over thousands of
transcripts can outlast the install run's 10-minute limit. It uses the recorder's own per-session writer
(`record.write_episode`), not a second recorder, with these differences:

  - every transcript older than 30 minutes counts as quiet, and a session gets one episode spanning its whole
    transcript (earlier resumes cannot be told apart);
  - the environment is gone, so `started_by` is `unknown`;
  - rows copied from the past carry source `backfill` where their table has one;
  - Session Atlas's database is read read-only, for lineage and for titles. Its focus fields (summary and
    focus state) are never selected, let alone copied;
  - a session the recorder already wrote is left alone, so running it twice adds nothing;
  - Jira is read at most once per ticket key in the pass.

The report on stdout is counts and reason codes only: no path, title or id. Python 3.9, standard library only.
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
from pathlib import Path
from typing import Callable, Dict, Optional

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from ledger import _repo  # noqa: E402,F401
from laptop import common  # noqa: E402
from ledger import costs, db, homes, record, sessions, transcript  # noqa: E402

BY = "ledger/backfill.py"
ATLAS_TITLE_SOURCE = {"native": "tool", "worker": "ai", "fallback": "fallback"}
ATLAS_CONFIDENCE = {"confirmed": "confirmed", "inferred": "inferred", "unknown": "inferred"}


def open_atlas(path: Path) -> Optional[sqlite3.Connection]:
    """Session Atlas's database, read-only, or None when it is missing or unreadable."""
    try:
        if not path.is_file():
            return None
        conn = sqlite3.connect("file:{}?mode=ro".format(path), uri=True, timeout=5.0)
        conn.execute("SELECT session_id FROM sessions LIMIT 1")
        conn.execute("SELECT child_session_id FROM session_lineage LIMIT 1")
        return conn
    except sqlite3.Error:
        return None


def _atlas_titles(atlas: Optional[sqlite3.Connection]) -> Dict[str, tuple]:
    """session id -> (title, ledger title source). Only these columns are read: never `summary`."""
    if atlas is None:
        return {}
    out = {}
    for sid, title, source in atlas.execute("SELECT session_id, title, title_source FROM sessions"):
        if title:
            out[sid] = (title, ATLAS_TITLE_SOURCE.get(source, "fallback"))
    return out


def _memo(jira: Callable) -> Callable:
    cache: Dict[str, object] = {}

    def read(key: str):
        if key not in cache:
            cache[key] = jira(key)
        return cache[key]
    return read


def _copy_lineage(conn: sqlite3.Connection, atlas: sqlite3.Connection, now: str, counts: dict,
                  skips: Dict[str, int]) -> None:
    """Atlas's lineage, kept with its confidence. A session only Atlas knows is given a row from Atlas's own start
    time and folder (never its title or summary), so the lineage has something to point at."""
    info = {sid: (started, cwd, path, bool(sub)) for sid, started, cwd, path, sub in atlas.execute(
        "SELECT session_id, started_at, start_cwd, transcript_path, is_subagent FROM sessions")}

    def uid_of(sid: str) -> Optional[str]:
        row = conn.execute("SELECT session_uid FROM sessions WHERE tool_session_id = ?", (sid,)).fetchone()
        if row:
            return row[0]
        if sid not in info:
            return None
        started, cwd, path, _ = info[sid]
        before = conn.total_changes
        uid = sessions.ensure(conn, tool="claude-code", tool_session_id=sid, started_at=started or now,
                              started_by="unknown", now=now, by=BY, start_folder=cwd, transcript_path=path)
        counts["sessions"] += conn.total_changes - before
        return uid

    for child, parent, root, confidence in atlas.execute(
            "SELECT child_session_id, parent_session_id, root_session_id, confidence FROM session_lineage "
            "ORDER BY child_session_id"):
        try:
            with db.transaction(conn):
                known = conn.execute("SELECT session_uid FROM sessions WHERE tool_session_id = ?", (child,)).fetchone()
                if known and conn.execute("SELECT 1 FROM session_lineage WHERE child_uid = ?", (known[0],)).fetchone():
                    skips["lineage-already-there"] += 1
                    continue
                uids = [uid_of(x) for x in (child, parent, root)]
                if None in uids or child == parent:
                    skips["lineage-session-unknown"] += 1
                    continue
                kind = "subagent" if info.get(child, (0, 0, 0, False))[3] else "resume"
                conn.execute(
                    "INSERT INTO session_lineage (child_uid, parent_uid, root_uid, kind, confidence, discovered_at, "
                    "recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (uids[0], uids[1], uids[2], kind, ATLAS_CONFIDENCE.get(confidence, "inferred"), now, BY))
                counts["lineage"] += 1
        except Exception as e:  # noqa: BLE001
            record._log("backfill: lineage row skipped: {}: {}".format(type(e).__name__, e))
            skips["error"] += 1


def backfill(conn: sqlite3.Connection, *, atlas: Optional[sqlite3.Connection], cost_db, projects: Path, now: str,
             git: record.GitRun, jira: Callable, conventions: dict,
             claude_home: Optional[Path] = None) -> Dict[str, object]:
    """Counts by table, and the sessions skipped by reason code."""
    counts = {"sessions": 0, "episodes": 0, "refs": 0, "homes": 0, "costs": 0, "notes": 0, "lineage": 0}
    skips = {"already-recorded": 0, "recent": 0, "empty": 0, "error": 0, "lineage-already-there": 0,
             "lineage-session-unknown": 0}
    titles = _atlas_titles(atlas)
    jira = _memo(jira)
    now_epoch = record._epoch(now)
    found = record._find_transcripts(projects, now_epoch, days=None)
    for sid in sorted(found, key=lambda s: ("+" in s, s)):  # main sessions first, so a subagent's parent exists
        path = found[sid]
        try:
            if path.stat().st_mtime > now_epoch - record.QUIET_AFTER_SECONDS:
                skips["recent"] += 1  # still being worked in: the recorder's, not the backfill's
                continue
            row = conn.execute("SELECT session_uid FROM sessions WHERE tool_session_id = ?", (sid,)).fetchone()
            if row and conn.execute("SELECT 1 FROM session_episodes WHERE session_uid = ? LIMIT 1",
                                    (row[0],)).fetchone():
                skips["already-recorded"] += 1
                continue
            meta = transcript.read_meta(path)
            if meta.lines_read == 0:
                skips["empty"] += 1
                continue
            record.write_episode(conn, sid, path, meta, ended_at=None, now=now, git=git, jira=jira, conv=conventions,
                                 counts=counts, cost_db=cost_db, claude_home=claude_home, by=BY, source="backfill",
                                 title_hint=titles.get(sid, (None, None)))
        except Exception as e:  # noqa: BLE001  (one bad transcript never stops the rest)
            record._log("backfill: skipped a transcript: {}: {}".format(type(e).__name__, e))
            skips["error"] += 1
    if atlas is not None:
        _copy_lineage(conn, atlas, now, counts, skips)
    return dict(counts, skipped=skips)


def main() -> int:
    from ledger import jira_read
    home = Path.home() / ".claude"
    conv = homes.load_conventions(record._conventions_version(), str(Path.home()))
    names = [s["name"] for s in conv["registry"].get("systems") or []]
    fetch = jira_read.make_fetch(os.environ)
    conn = db.connect_existing(db.ledger_path())
    atlas = open_atlas(home / "atlas" / "atlas.db")
    cost_db = costs.open_cost_ledger(home / "cost-ledger" / "ledger.db")
    try:
        report = backfill(conn, atlas=atlas, cost_db=cost_db, projects=home / "projects", now=common.now_utc(),
                          git=record.real_git, jira=lambda key: jira_read.ticket_context(key, fetch, names),
                          conventions=conv, claude_home=home)
    finally:
        conn.close()
        for other in (atlas, cost_db):
            if other is not None:
                other.close()
    print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
