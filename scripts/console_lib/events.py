"""One event in the console, and the rules that class a line of text (JP-185). Python 3.9, standard library only.

A kind says how a line looks: `error` (red), `stop` (yellow), `needs` (the NEEDS JOSH badge), `start` (cyan),
`ok` (green), `info` (plain) and `quiet` (dim). The rules only read the words a line already holds; nothing here
adds text that was not in a log or the ledger.
"""
from __future__ import annotations

import datetime
import re
from typing import NamedTuple, Optional

KINDS = ("error", "stop", "needs", "start", "ok", "info", "quiet")
TICKET = re.compile(r"\b[A-Z][A-Z0-9]{1,9}-\d+\b")
RUN_ID = re.compile(r"\br-[0-9a-f]{6,16}\b")
STAMP = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?\s")
MAX_TEXT = 300

ERROR_WORDS = re.compile(r"\b(fail(ed|s|ure)?|error|traceback|exception|refused|could not|cannot|unreadable|"
                         r"blocked|denied|timed out|not published|not kept|not placed|not noted)\b", re.I)
STOP_WORDS = re.compile(r"\b(stopped|abandon(ed)?|time limit|cut off|gave up|on hold|paused|switched off|runner-off)\b", re.I)
EXCEPTION_NAME = re.compile(r"\b[A-Z]\w*(Error|Exception)\b")
NEEDS_WORDS = re.compile(r"\b(needs?[- ]josh|waiting for josh|question for josh|ask(ed)? josh)\b", re.I)
START_WORDS = re.compile(r"\b(started|starting|spawn(ed)?|launch(ed)?|picked up)\b", re.I)
OK_WORDS = re.compile(r"\b(recorded|finished|passed|succeeded|done|merged|ok)\b", re.I)


class Event(NamedTuple):
    at: str                      # ISO time in UTC, "YYYY-MM-DDTHH:MM:SSZ"
    source: str                  # a short tag: ledger, runner, advance, job, hooks, session
    kind: str                    # one of KINDS
    text: str
    ticket: Optional[str] = None
    run: Optional[str] = None
    order: int = 0               # keeps lines of one source in the order they were read when the times tie


def now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def iso_from_epoch(seconds: float) -> str:
    return datetime.datetime.fromtimestamp(seconds, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def normalise(stamp: object) -> Optional[str]:
    """Any ISO time the sources write (Z, +00:00, fractions, a space for T) as UTC 'YYYY-MM-DDTHH:MM:SSZ', else None."""
    if not isinstance(stamp, str) or len(stamp) < 19:
        return None
    text = stamp.strip().replace(" ", "T", 1)
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        when = datetime.datetime.fromisoformat(text)
    except ValueError:
        try:
            when = datetime.datetime.fromisoformat(text[:19])
        except ValueError:
            return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=datetime.timezone.utc)
    return when.astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def split_stamp(line: str):
    """(time, rest) when the line starts with an ISO time, else (None, line)."""
    found = STAMP.match(line)
    if not found:
        return None, line
    return normalise(found.group(1) + (found.group(2) or "Z")), line[found.end():]


def classify(text: str, default: str = "info") -> str:
    """The kind a free-text log line gets. Needs-Josh first, then errors, stops, starts, clean ends."""
    if NEEDS_WORDS.search(text):
        return "needs"
    if ERROR_WORDS.search(text) or EXCEPTION_NAME.search(text):
        return "error"
    if STOP_WORDS.search(text):
        return "stop"
    if START_WORDS.search(text):
        return "start"
    if OK_WORDS.search(text):
        return "ok"
    return default


def outcome_kind(outcome: str) -> str:
    """The kind of a step's outcome word, as the walker records it."""
    word = (outcome or "").lower()
    if word.startswith("_abandon") or word in ("stopped", "timeout", "time_limit"):
        return "stop"
    if any(part in word for part in ("needs", "question", "ask", "input")):
        return "needs"
    if any(part in word for part in ("fail", "error", "refus", "reject", "block", "defect", "changes")):
        return "error"
    return "ok"


def tickets_in(text: str) -> Optional[str]:
    found = TICKET.search(text or "")
    return found.group(0) if found else None


def run_in(text: str) -> Optional[str]:
    found = RUN_ID.search(text or "")
    return found.group(0) if found else None


def shorten(text: str, limit: int = MAX_TEXT) -> str:
    """One screen line: control characters and newlines become spaces, long text ends with an ellipsis."""
    flat = "".join(ch if ch.isprintable() else " " for ch in (text or "")).strip()
    flat = re.sub(r"\s{2,}", " ", flat)
    return flat if len(flat) <= limit else flat[: limit - 1] + "…"


def make(at: Optional[str], source: str, kind: str, text: str, ticket: Optional[str] = None,
         run: Optional[str] = None, order: int = 0) -> Event:
    text = shorten(text)
    return Event(at or now_iso(), source, kind if kind in KINDS else "info", text,
                 ticket or tickets_in(text), run or run_in(text), order)
