"""Copy a session's U-turns, dead ends and untold findings out of its STATE.md (JP-107, Task 6).

The harness keeps `~/.claude/session-state/<session id>/STATE.md` for each session and deletes it after 30 days. Three
of its sections hold what a later improvement review wants: U-turns, Dead ends and Findings. Each bullet is screened
for patient data (a bullet that fails is stored as the withheld marker, so the count stays true) and cut to 300
characters. A session in a `.phi` folder stores none. Python 3.9, standard library only.
"""
from __future__ import annotations

import re
import sqlite3
from pathlib import Path
from typing import List, Optional, Tuple

from ledger.text import CAPS, short_text

BY = "ledger/state_notes.py"
# STATE_TEMPLATE in claude-harness hooks/compaction/state.py names these headings.
SECTIONS = {"U-turns": "u-turn", "Dead ends": "dead-end", "Findings": "untold-finding"}
CAP = CAPS[("session_state_notes", "note")]
_UNTOLD = re.compile(r"told the user:?\s*no[\s.)\]]*$", re.IGNORECASE)


def state_file(tool_session_id: str, claude_home: Optional[Path] = None) -> Path:
    return (claude_home or Path.home() / ".claude") / "session-state" / tool_session_id / "STATE.md"


def parse(text: str) -> List[Tuple[str, str]]:
    """(kind, bullet text) for the bullets under the three headings. Template placeholders, which are wholly in
    parentheses, are skipped, and a finding counts only when it ends `told the user no`."""
    out: List[Tuple[str, str]] = []
    kind: Optional[str] = None
    for raw in text.splitlines():
        if raw.startswith("## "):
            kind = SECTIONS.get(raw[3:].strip())
            continue
        if kind is None or not raw.startswith("- "):
            continue
        bullet = raw[2:].strip()
        if not bullet or (bullet.startswith("(") and bullet.endswith(")")):
            continue
        if kind == "untold-finding" and not _UNTOLD.search(bullet):
            continue
        out.append((kind, bullet))
    return out


def copy_notes(conn: sqlite3.Connection, file: Optional[Path], uid: str, episode: int, keeps_words: bool,
               now: str) -> int:
    """Rows written. Nothing is read, let alone written, when keeps_words is false or there is no STATE.md. STATE.md
    is cumulative, so a note already stored for the session is not stored again (a repeat counts, so two identical
    bullets stay two)."""
    if not keeps_words or file is None:
        return 0
    try:
        text = file.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return 0
    wanted: dict = {}
    for kind, bullet in parse(text):
        note, _ = short_text(bullet, CAP)
        if note:
            wanted[(kind, note)] = wanted.get((kind, note), 0) + 1
    written = 0
    for (kind, note), count in sorted(wanted.items()):
        have = conn.execute("SELECT COUNT(*) FROM session_state_notes WHERE session_uid = ? AND kind = ? AND note = ?",
                            (uid, kind, note)).fetchone()[0]
        for _ in range(max(0, count - have)):
            conn.execute("INSERT INTO session_state_notes (session_uid, episode, kind, note, copied_at, recorded_by) "
                         "VALUES (?, ?, ?, ?, ?, ?)", (uid, episode, kind, note, now, BY))
            written += 1
    return written
