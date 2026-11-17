"""Write friction facts to the ledger, and bring older episodes up to date (JP-112). Python 3.9, standard library only.

`record_episode` is called by the recorder (and so by the backfill) in the transaction that writes an episode, so an
episode and its facts appear together. `catch_up` and the `ledger-friction-catchup` job do the same for episodes
recorded before JP-112 merged, reading each one's transcript by the episode's own time range. Nothing here calls a
model or the network, and no row holds message text: facts are numbers under a code from `ledger/codes.json`, usage
rows hold a plain identifier, a count and a flag.

    python3 ledger/friction_write.py     one pass over the episodes with no friction facts; prints counts
"""
from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path
from typing import Dict, Iterable, Optional, Tuple

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from ledger import _repo  # noqa: E402,F401
from laptop import common  # noqa: E402
from ledger import db, friction  # noqa: E402
from ledger.text import short_text  # noqa: E402

BY = "ledger/friction_write.py"
CODES_FILE = Path(__file__).resolve().parent / "codes.json"
# Facts the recorder writes from other sources (STATE.md notes, compaction marks): their presence says nothing about
# whether this module has run for an episode.
OTHER_WRITERS = ("compactions", "u_turns", "dead_ends")


def fact_codes() -> Dict[str, str]:
    return json.loads(CODES_FILE.read_text(encoding="utf-8"))["session_facts"]


def record_episode(conn: sqlite3.Connection, uid: str, episode: int, facts: friction.Facts, now: str, *,
                   instructions: Iterable[Tuple[str, int]] = (), by: str = BY) -> Dict[str, int]:
    """Write one episode's facts and usage. A code that is not in codes.json is refused (ValueError), a value of zero
    is not written (absent means zero), and a fact or usage row already there is left alone, so writing twice is safe.
    `instructions` are the (label, size) pairs from `friction.instruction_files`."""
    codes = fact_codes()
    counts = dict(facts.counts)
    usage = {key: list(value) for key, value in facts.usage.items()}
    total = 0
    for label, size in instructions:
        total += size
        shown, withheld = short_text(label, 120)
        if shown == label and not withheld:  # a path that is too long, or fails the screen, is counted but not named
            usage.setdefault(("rule-file", label), [1, 0])
    if total > 0:
        counts["instruction_bytes_loaded"] = total
    for code in counts:
        if code not in codes:
            raise ValueError("friction code {!r} is not in ledger/codes.json".format(code))
    wrote = {"facts": 0, "usage": 0}
    for code in sorted(counts):
        value = int(counts[code])
        if value <= 0 or conn.execute("SELECT 1 FROM session_facts WHERE session_uid = ? AND episode = ? AND fact = ?",
                                      (uid, episode, code)).fetchone():
            continue
        conn.execute("INSERT INTO session_facts (session_uid, episode, fact, value, recorded_at, recorded_by) "
                     "VALUES (?, ?, ?, ?, ?, ?)", (uid, episode, code, value, now, by))
        wrote["facts"] += 1
    for (kind, name), (loaded, uses) in sorted(usage.items()):
        if conn.execute("SELECT 1 FROM session_usage WHERE session_uid = ? AND episode = ? AND item_kind = ? "
                        "AND item_name = ?", (uid, episode, kind, name)).fetchone():
            continue
        conn.execute("INSERT INTO session_usage (session_uid, episode, item_kind, item_name, loaded, uses, "
                     "recorded_at, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                     (uid, episode, kind, name, 1 if loaded or uses else 0, uses, now, by))
        wrote["usage"] += 1
    return wrote


def catch_up(conn: sqlite3.Connection, *, projects: Path, now: str, claude_home: Optional[Path] = None,
             limit: Optional[int] = None) -> Dict[str, int]:
    """Facts for every current episode that has none of this module's. The transcript is found by the session's id
    and read between the episode's first and last line. An episode whose transcript is gone is counted and left."""
    from ledger import record  # late: record imports this module
    claude_home = claude_home or Path.home() / ".claude"
    done = ",".join("'{}'".format(c) for c in OTHER_WRITERS)
    rows = conn.execute(
        """SELECT e.session_uid, e.episode, e.began_at, e.last_activity_at, e.folder, s.tool_session_id, s.started_by
           FROM current_session_episodes e JOIN sessions s ON s.session_uid = e.session_uid
           WHERE NOT EXISTS (SELECT 1 FROM session_facts f WHERE f.session_uid = e.session_uid
                             AND f.episode = e.episode AND f.fact NOT IN ({}))
           ORDER BY e.id""".format(done)).fetchall()
    counts = {"episodes": 0, "facts": 0, "usage": 0, "no_transcript": 0, "errors": 0}
    found = record._find_transcripts(projects, record._epoch(now), days=None)
    for uid, episode, began, last, folder, sid, started_by in rows[:limit]:
        path = found.get(sid)
        if path is None:
            counts["no_transcript"] += 1
            continue
        try:
            who = friction.who_for(started_by, "+" in sid)
            facts = friction.read(path, who=who, since=began, until=last)
            files = [] if who == "subagent" else friction.instruction_files(folder, claude_home)
            with db.transaction(conn):
                wrote = record_episode(conn, uid, episode, facts, now, instructions=files)
            counts["episodes"] += 1
            counts["facts"] += wrote["facts"]
            counts["usage"] += wrote["usage"]
        except Exception as e:  # noqa: BLE001  (one bad transcript never stops the rest)
            record._log("friction catch-up skipped {}: {}: {}".format(sid, type(e).__name__, e))
            counts["errors"] += 1
    return counts


def main() -> int:
    conn = db.connect_existing(db.ledger_path())
    try:
        counts = catch_up(conn, projects=Path.home() / ".claude" / "projects", now=common.now_utc())
    finally:
        conn.close()
    print(json.dumps(counts, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
