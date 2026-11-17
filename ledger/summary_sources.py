"""Where a session summary's words come from (JP-108). Python 3.9, standard library only.

`transcript.py` never reads message text. This module is the one place that does, and only for the summary, under Josh's
answer at the JP-106 sitting (16 November 2026): the summary's "what was asked" line may copy the first line of the
session's first message. It reads at most the first `MAX_LINES` lines of a transcript, skips tool results and text the
tools inject (anything that starts with `<`), and hands back short strings. Nothing here screens or stores anything:
`ledger/summary.py` screens every piece before it is written.

    first_line(path)   the first line of the first real message Josh sent, or None
    excerpt(path)      a few short messages, for the one small model call only
    timeline(file)     the (request, status) pairs under `## Timeline` in a session's STATE.md
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import List, Optional, Tuple

MAX_LINES = 400
MAX_LINE_BYTES = 1_000_000
FIRST_LINE_CAP = 160
EXCERPT_MESSAGES = 4
EXCERPT_EACH = 400
EXCERPT_TOTAL = 3000
SKIPPED_STARTS = ("<", "Caveat:", "[Request interrupted")


def _text_of(content: object) -> Optional[str]:
    """The text of a message's content: a string, or the text blocks of a list. A message made only of tool results
    has none."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [b.get("text") for b in content if isinstance(b, dict) and b.get("type") == "text"
                 and isinstance(b.get("text"), str)]
        return "\n".join(parts) if parts else None
    return None


def _messages(path: Path, role: str) -> List[str]:
    """The text of the first MAX_LINES lines' messages with this role, in order, main thread only."""
    found: List[str] = []
    try:
        with path.open("rb") as f:
            for _ in range(MAX_LINES):
                raw = f.readline(MAX_LINE_BYTES + 1)
                if not raw:
                    break
                if len(raw) > MAX_LINE_BYTES or not raw.endswith(b"\n"):
                    continue
                try:
                    line = json.loads(raw.decode("utf-8", errors="replace"))
                except ValueError:
                    continue
                if not isinstance(line, dict) or line.get("type") != role or line.get("isSidechain") is True:
                    continue
                if line.get("isMeta") is True:
                    continue
                message = line.get("message")
                text = _text_of(message.get("content")) if isinstance(message, dict) else None
                if text and text.strip() and not text.lstrip().startswith(SKIPPED_STARTS):
                    found.append(text.strip())
    except OSError:
        return []
    return found


def first_line(path: Optional[Path]) -> Optional[str]:
    """The first non-empty line of the first real user message, cut to FIRST_LINE_CAP characters (not screened)."""
    if path is None:
        return None
    for text in _messages(Path(path), "user"):
        for line in text.splitlines():
            line = " ".join(line.split())
            if line:
                return line[:FIRST_LINE_CAP]
    return None


def excerpt(path: Optional[Path]) -> List[Tuple[str, str]]:
    """(role, short text) pairs for the one small model call: the first few user messages and the last assistant
    message found in the first MAX_LINES lines, EXCERPT_EACH characters each and EXCERPT_TOTAL in all."""
    if path is None:
        return []
    users = _messages(Path(path), "user")[:EXCERPT_MESSAGES]
    assistants = _messages(Path(path), "assistant")[-1:]
    out: List[Tuple[str, str]] = []
    total = 0
    for role, text in [("user", t) for t in users] + [("assistant", t) for t in assistants]:
        piece = " ".join(text.split())[:EXCERPT_EACH]
        if total + len(piece) > EXCERPT_TOTAL:
            break
        out.append((role, piece))
        total += len(piece)
    return out


def timeline(file: Optional[Path]) -> List[Tuple[str, Optional[str]]]:
    """(request, status) for each entry under `## Timeline` in STATE.md. The template's placeholder (wholly in
    parentheses) is skipped, and an entry may have no status yet."""
    if file is None:
        return []
    try:
        text = Path(file).read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return []
    entries: List[List[Optional[str]]] = []
    inside = False
    for raw in text.splitlines():
        if raw.startswith("## "):
            inside = raw[3:].strip() == "Timeline"
            continue
        if not inside:
            continue
        body = raw.strip().lstrip("-").strip()
        if body.lower().startswith("user request:"):
            entries.append([body.split(":", 1)[1].strip(), None])
        elif body.lower().startswith("status:") and entries:
            entries[-1][1] = body.split(":", 1)[1].strip()
    out: List[Tuple[str, Optional[str]]] = []
    for request, status in entries:
        placeholder = bool(request) and request.startswith("(") and request.endswith(")")
        if request and not placeholder:
            status = None if status is None or (status.startswith("(") and status.endswith(")")) or not status else status
            out.append((request, status))
    return out
