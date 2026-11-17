"""The trimmed copy of one episode that the debrief call reads (JP-113). Python 3.9, standard library only.

With `summary_sources.py`, this is one of the two places that read message text, and it reads it only to build this copy.
The copy holds Josh's messages (a script's prompts, for a session a script started), the agent's replies, error lines and the
STATE.md record. Tool output and file contents are left out: a tool result is looked at only to see whether it was an
error, and an error is cut to its first line. Each piece is cut, goes through the patient-data screen (a piece that
fails is left out and counted), and has the prompt's own marker characters defused, so text in a transcript cannot end
the data block early.

Every turn kept gets a handle (T1, T2, ...). The model points at a turn by handle and never writes a quote; the script
turns the handle into the transcript line's id when it stores the moment.

For a long episode, or one that was compacted, the agent's replies are dropped and the saved compaction summaries stand
in with STATE.md, so the call costs about the same however long the session ran. Josh's messages stay (a few), because
they are what a moment can point at.

    build(...)  ->  Trimmed(text, handles, long_mode, withheld)
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from ledger import friction, state_notes, summary_sources
from ledger.text import short_text
from ledger.transcript import _time

BUDGET = 9000                 # characters of turns before the long-episode form is used
CAP_MESSAGE, CAP_REPLY, CAP_ERROR = 300, 300, 160
MAX_HANDLED_MESSAGES = 15     # Josh's messages kept in the long form (first 5, last 10)
MAX_ERRORS, MAX_INTERRUPTS = 10, 10
STATE_NOTES_MAX, STATE_NOTE_CAP = 12, 200
TIMELINE_MAX, TIMELINE_CAP = 5, 150
COMPACTIONS_KEPT, COMPACTION_CAP, COMPACTION_READ = 2, 1200, 20000
_LINE_ID = re.compile(r"^[A-Za-z0-9_:.\-]{1,80}$")
_MARKERS = re.compile(r"<<<|>>>")


@dataclass
class Trimmed:
    text: str = ""
    handles: Dict[str, str] = field(default_factory=dict)   # T1 -> the transcript line's id
    long_mode: bool = False
    withheld: int = 0
    turns: int = 0


def defuse(text: str) -> str:
    """The prompt marks the data block with <<< and >>>; text inside it cannot carry either."""
    return _MARKERS.sub(lambda m: " ".join(m.group(0)), text)


def _first_line(text: str) -> str:
    return next((" ".join(line.split()) for line in text.splitlines() if line.strip()), "")


def _items(path: Path, who: str, since: Optional[str], until: Optional[str]) -> List[Tuple[str, str, str]]:
    """(role, text, line id) for the turns of the episode worth reading, in order. Roles: JOSH or PROMPT, AGENT,
    INTERRUPT and ERROR. A line with no usable id is skipped, because a moment could not point at it."""
    items: List[Tuple[str, str, str]] = []
    tools: Dict[str, str] = {}
    try:
        lines = list(friction._lines(path, 0, None, friction.Facts()))
    except OSError:
        return []
    for line in lines:
        stamp = _time(line.get("timestamp"))
        if stamp and ((since and stamp < since) or (until and stamp > until)):
            continue
        if line.get("isSidechain") is True or line.get("isMeta") is True or line.get("isCompactSummary") is True:
            continue
        line_id = line.get("uuid")
        kind = line.get("type")
        message = line.get("message") if isinstance(line.get("message"), dict) else {}
        blocks = friction._blocks(message.get("content"))
        if kind == "assistant":
            if line.get("isApiErrorMessage") is True:
                continue
            for block in blocks:
                if block.get("type") == "tool_use" and isinstance(block.get("id"), str):
                    tools[block["id"]] = str(block.get("name") or "tool")
            text = "\n".join(b["text"] for b in blocks if b.get("type") == "text" and isinstance(b.get("text"), str))
            if text.strip() and isinstance(line_id, str) and _LINE_ID.match(line_id):
                items.append(("AGENT", text, line_id))
        elif kind == "user" and isinstance(line_id, str) and _LINE_ID.match(line_id):
            for block in blocks:
                if block.get("type") == "tool_result":
                    name = tools.pop(block.get("tool_use_id"), "tool")
                    body = friction._text_of(block)
                    if block.get("is_error") is True and not body.startswith(friction.REJECTED):
                        items.append(("ERROR", "{}: {}".format(name, _first_line(body)), line_id))
                elif block.get("type") == "text":
                    text = friction._text_of(block).lstrip()
                    if text.startswith(friction.INTERRUPT):
                        items.append(("INTERRUPT", "Josh stopped the agent mid-step", line_id))
                    elif text and not text.startswith(friction.NOT_JOSH):
                        items.append(("JOSH" if who == "josh" else "PROMPT", text, line_id))
                    break
    return items


def _screen(items: List[Tuple[str, str, str]]) -> Tuple[List[Tuple[str, str, str]], int]:
    caps = {"JOSH": CAP_MESSAGE, "PROMPT": CAP_MESSAGE, "AGENT": CAP_REPLY, "ERROR": CAP_ERROR, "INTERRUPT": CAP_MESSAGE}
    kept: List[Tuple[str, str, str]] = []
    withheld = 0
    for role, text, line_id in items:
        out, hit = short_text(text, caps[role])
        if hit:
            withheld += 1
        elif out:
            kept.append((role, defuse(out), line_id))
    return kept, withheld


def _long_form(items: List[Tuple[str, str, str]]) -> List[Tuple[str, str, str]]:
    """Josh's (or the script's) messages, errors and interrupts only; replies are left to STATE.md and the compactions."""
    said = [i for i in items if i[0] in ("JOSH", "PROMPT")]
    if len(said) > MAX_HANDLED_MESSAGES:
        said = said[:5] + said[-(MAX_HANDLED_MESSAGES - 5):]
    errors = [i for i in items if i[0] == "ERROR"][:MAX_ERRORS]
    stops = [i for i in items if i[0] == "INTERRUPT"][:MAX_INTERRUPTS]
    keep = set(map(id, said + errors + stops))
    return [i for i in items if id(i) in keep]


def _state_section(state_file: Optional[Path]) -> Tuple[List[str], int]:
    """STATE.md's U-turns, dead ends and untold findings, and its timeline, screened. Returns (lines, withheld)."""
    if state_file is None:
        return [], 0
    out: List[str] = []
    withheld = 0
    try:
        text = Path(state_file).read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return [], 0
    label = {"u-turn": "U-TURN", "dead-end": "DEAD END", "untold-finding": "FINDING"}
    for kind, bullet in state_notes.parse(text)[:STATE_NOTES_MAX]:
        shown, hit = short_text(bullet, STATE_NOTE_CAP)
        if hit:
            withheld += 1
        elif shown:
            out.append("{}: {}".format(label[kind], defuse(shown)))
    for request, status in summary_sources.timeline(Path(state_file))[:TIMELINE_MAX]:
        shown, hit = short_text("{} -> {}".format(request, status or "no status yet"), TIMELINE_CAP)
        if hit:
            withheld += 1
        elif shown:
            out.append("REQUEST: " + defuse(shown))
    return out, withheld


def _compactions(directory: Optional[Path]) -> Tuple[List[str], int]:
    """The newest saved compaction summaries, each screened as a whole and cut. Returns (lines, withheld)."""
    if directory is None:
        return [], 0
    try:
        files = sorted(p for p in Path(directory).iterdir() if p.is_file() and p.suffix == ".md")[-COMPACTIONS_KEPT:]
    except OSError:
        return [], 0
    out: List[str] = []
    withheld = 0
    for file in files:
        try:
            raw = file.read_text(encoding="utf-8")[:COMPACTION_READ]
        except (OSError, UnicodeError):
            continue
        shown, hit = short_text(raw, COMPACTION_CAP)
        if hit:
            withheld += 1
        elif shown:
            out.append("COMPACTION SUMMARY: " + defuse(shown))
    return out, withheld


def build(path: Optional[Path], *, who: str, since: Optional[str] = None, until: Optional[str] = None,
          state_file: Optional[Path] = None, compactions_dir: Optional[Path] = None,
          compacted: bool = False) -> Trimmed:
    """The trimmed copy of the lines of `path` between `since` and `until`. An unreadable transcript still gives a
    copy made of STATE.md (and the compactions, for a compacted episode)."""
    items, withheld = _screen(_items(Path(path), who, since, until) if path else [])
    long_mode = compacted or sum(len(i[1]) + 12 for i in items) > BUDGET
    if long_mode:
        items = _long_form(items)
    handles: Dict[str, str] = {}
    rows: List[str] = []
    for n, (role, text, line_id) in enumerate(items, 1):
        handles["T{}".format(n)] = line_id
        rows.append("T{} {}: {}".format(n, role, text))
    notes, lost = _state_section(state_file)
    sections = ["TURNS:"] + (rows or ["(none could be read)"])
    if notes:
        sections += ["STATE.md RECORD:"] + notes
    kept_compactions: List[str] = []
    if long_mode:
        kept_compactions, lost_c = _compactions(compactions_dir)
        lost += lost_c
        if kept_compactions:
            sections += kept_compactions
    return Trimmed("\n".join(sections), handles, long_mode, withheld + lost, len(rows))
