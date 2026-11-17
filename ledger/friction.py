"""Friction facts: counts read from one episode's transcript lines (JP-112). Python 3.9, standard library only.

This reads the structure of a Claude Code transcript (who spoke, which tool was called, whether a result was an error,
the token counts of the first turn, the time between lines) and keeps only numbers and a few plain identifiers. It
makes no model call and no network call. The text of what Josh and the agent said, commands and command output are
looked at in memory to answer a yes-or-no question (does this message start with the interrupt marker; does the agent's
last sentence end in a question mark), and are then dropped. A command or a file name is reduced to a hash so that "the
same command failed again" can be counted; the hash is not kept either. What leaves this module is:

    counts   code -> number, for the codes in ledger/codes.json ("session_facts")
    usage    (kind, name) -> [loaded, uses], kind being skill, agent, tool or mcp-server; the name must be a plain
             identifier that passes the patient-data screen, so no message text can reach a ledger row through it

`who` says whose messages these are: "josh" (Josh may have typed them), "scripted" (a walker, daemon, desk or Josh 360
session: its prompts come from a script, so none is Josh's message), or "subagent" (a subagent's transcript: its first
message is the parent's prompt, and its lines are its own, not sidechain noise). Josh's answers to an AskUserQuestion
count for "josh" and "scripted", since a person gave them.
"""
from __future__ import annotations

import calendar
import hashlib
import json
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Iterator, List, Optional, Tuple

from ledger import _repo  # noqa: F401  (puts graphs/gates on sys.path)
from ledger.text import short_text
from ledger.transcript import MAX_LINE, _time

WHO = ("josh", "scripted", "subagent")
SCRIPTED_STARTERS = ("walker", "daemon", "desk", "josh-360")
WAIT_CAP_SECONDS = 4 * 3600      # time before one of Josh's messages counts as waiting on him, at most this much
WORK_CAP_SECONDS = 30 * 60       # one gap between two working lines counts as working, at most this much
CONTEXT_WINDOW = 200_000
CONTEXT_WINDOW_LARGE = 1_000_000
INTERRUPT = "[Request interrupted by user"
REJECTED = "The user doesn't want to proceed"
PROMPT_TOO_LONG = "Prompt is too long"
# User lines that are not Josh's words: tool and command output, injected reminders, notifications.
NOT_JOSH = ("<local-command-stdout", "<local-command-stderr", "<local-command-caveat", "Caveat:", "<system-reminder",
            "<task-notification", "<bash-stdout", "<bash-stderr", "<user-prompt-submit-hook")
MAX_LOADED = 300
_NAME = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_:.\-/@+]{0,119}$")
_LISTED = re.compile(r"^- ([A-Za-z0-9_][A-Za-z0-9_:.\-/@+]*)")


@dataclass
class Facts:
    counts: Dict[str, int] = field(default_factory=dict)
    usage: Dict[Tuple[str, str], List[int]] = field(default_factory=dict)   # (kind, name) -> [loaded, uses]
    lines: int = 0
    skipped: int = 0


def _epoch(stamp: str) -> int:
    return calendar.timegm(time.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ"))


def _hash(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8", errors="replace")).hexdigest()


def clean_name(value: object) -> Optional[str]:
    """The name as a plain identifier that passes the patient-data screen, or None."""
    if not isinstance(value, str) or not _NAME.match(value):
        return None
    out, withheld = short_text(value, 120)
    return out if out == value and not withheld else None


def _blocks(content: object) -> List[dict]:
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    return [b for b in content if isinstance(b, dict)] if isinstance(content, list) else []


def _text_of(block: dict) -> str:
    text = block.get("text") if block.get("type") == "text" else block.get("content")
    if isinstance(text, list):
        text = next((b.get("text") for b in text if isinstance(b, dict) and isinstance(b.get("text"), str)), "")
    return text if isinstance(text, str) else ""


class _Run:
    """The state of one pass over one episode's lines."""

    def __init__(self, who: str):
        self.who = who
        self.counts: Dict[str, int] = {}
        self.usage: Dict[Tuple[str, str], List[int]] = {}
        self.tools: Dict[str, Tuple[str, Optional[str]]] = {}   # tool_use id -> (tool name, command hash)
        self.failed: set = set()
        self.reads: Dict[str, int] = {}
        self.asked = False
        self.previous: Optional[int] = None
        self.waiting = 0
        self.working = 0
        self.first_tokens: Optional[int] = None
        self.first_model = ""

    def bump(self, code: str, by: int = 1) -> None:
        self.counts[code] = self.counts.get(code, 0) + by

    def use(self, kind: str, value: object, loaded_only: bool = False) -> None:
        name = clean_name(value)
        if name is None:
            return
        entry = self.usage.setdefault((kind, name), [0, 0])
        entry[0] = 1
        if not loaded_only:
            entry[1] += 1

    def tick(self, epoch: Optional[int], how: str) -> None:
        """Time since the previous line, counted by what ended the gap: Josh's reply (waiting), another line
        (working), or a prompt that came from a script (neither)."""
        if epoch is None:
            return
        if self.previous is not None and epoch >= self.previous:
            gap = epoch - self.previous
            if how == "wait":
                self.waiting += min(gap, WAIT_CAP_SECONDS)
            elif how == "work":
                self.working += min(gap, WORK_CAP_SECONDS)
        self.previous = epoch if self.previous is None else max(self.previous, epoch)

    # -- lines ---------------------------------------------------------------------------------------------------

    def line(self, line: dict) -> None:
        kind = line.get("type")
        if self.who != "subagent" and line.get("isSidechain") is True:
            return
        if kind == "system":
            if line.get("subtype") == "compact_boundary":
                self.bump("compactions")
        elif kind == "assistant":
            self.assistant(line)
        elif kind == "user":
            self.user(line)
        elif kind == "attachment":
            self.attachment(line)

    def assistant(self, line: dict) -> None:
        stamp = _time(line.get("timestamp"))
        message = line.get("message") if isinstance(line.get("message"), dict) else {}
        blocks = _blocks(message.get("content"))
        if line.get("isApiErrorMessage") is True:
            if any(_text_of(b).startswith(PROMPT_TOO_LONG) for b in blocks):
                self.bump("context_exhausted")
            return
        self.tick(_epoch(stamp) if stamp else None, "work")
        usage = message.get("usage")
        model = message.get("model") if isinstance(message.get("model"), str) else ""
        if self.first_tokens is None and isinstance(usage, dict) and model != "<synthetic>":
            tokens = sum(usage.get(k, 0) for k in ("input_tokens", "cache_creation_input_tokens",
                                                   "cache_read_input_tokens") if isinstance(usage.get(k), int))
            if tokens > 0:
                self.first_tokens, self.first_model = tokens, model
        for block in blocks:
            if block.get("type") == "text":
                self.asked = _text_of(block).rstrip().endswith("?")
            elif block.get("type") == "tool_use":
                self.tool_use(block)

    def tool_use(self, block: dict) -> None:
        name = block.get("name")
        if not isinstance(name, str):
            return
        given = block.get("input") if isinstance(block.get("input"), dict) else {}
        key = None
        if name == "Bash" and isinstance(given.get("command"), str):
            key = _hash(given["command"])
        elif name == "Read" and isinstance(given.get("file_path"), str):
            seen = _hash(given["file_path"])
            self.reads[seen] = self.reads.get(seen, 0) + 1
        if isinstance(block.get("id"), str):
            self.tools[block["id"]] = (name, key)
        self.asked = name == "AskUserQuestion"
        if name.startswith("mcp__"):
            self.use("mcp-server", name.split("__")[1] if name.count("__") >= 2 else None)
            return
        self.use("tool", name)
        if name == "Skill":
            self.use("skill", given.get("skill") or given.get("command"))
        elif name in ("Agent", "Task"):
            self.use("agent", given.get("subagent_type") or "general-purpose")

    def user(self, line: dict) -> None:
        if line.get("isCompactSummary") is True:
            return
        stamp = _time(line.get("timestamp"))
        message = line.get("message") if isinstance(line.get("message"), dict) else {}
        how, human, answered = "work", False, False
        for block in _blocks(message.get("content")):
            if block.get("type") == "tool_result":
                answered = self.tool_result(block) or answered
            elif block.get("type") == "text" and line.get("isMeta") is not True:
                text = _text_of(block).lstrip()
                if text.startswith(INTERRUPT):
                    self.bump("josh_interrupts")
                elif text and not text.startswith(NOT_JOSH):
                    human = True
        if answered:
            how = "wait"
        if human:
            how = "wait" if self.who == "josh" else "skip"
            if self.who == "josh":
                self.bump("josh_messages_answer" if self.asked else "josh_messages_unprompted")
            self.asked = False
        self.tick(_epoch(stamp) if stamp else None, how)

    def tool_result(self, block: dict) -> bool:
        """Count a failed command; True when this is Josh's answer to an AskUserQuestion."""
        name, key = self.tools.pop(block.get("tool_use_id"), (None, None))
        failed = block.get("is_error") is True
        if name == "AskUserQuestion" and not failed and self.who != "subagent":
            self.bump("josh_messages_answer")
            return True
        if name == "Bash" and failed and not _text_of(block).startswith(REJECTED):
            self.bump("failed_commands")
            if key is not None and key in self.failed:
                self.bump("repeat_failed_commands")
            if key is not None:
                self.failed.add(key)
        return False

    def attachment(self, line: dict) -> None:
        """What the session had available, when the transcript lists it: skills, and MCP servers."""
        given = line.get("attachment")
        if self.who == "subagent" or not isinstance(given, dict):
            return
        if given.get("type") == "skill_listing" and isinstance(given.get("content"), str):
            names = [m.group(1).rstrip(":") for m in (_LISTED.match(row) for row in given["content"].splitlines()) if m]
            for name in names[:MAX_LOADED]:
                self.use("skill", name, loaded_only=True)
        elif given.get("type") == "mcp_instructions_delta" and isinstance(given.get("addedNames"), list):
            for name in given["addedNames"][:MAX_LOADED]:
                self.use("mcp-server", name, loaded_only=True)

    def finish(self) -> Dict[str, int]:
        out = {code: value for code, value in self.counts.items() if value > 0}
        if self.first_tokens:
            window = CONTEXT_WINDOW_LARGE if "[1m]" in self.first_model or self.first_tokens > CONTEXT_WINDOW \
                else CONTEXT_WINDOW
            out["context_first_turn_pct"] = max(1, min(100, round(100 * self.first_tokens / window)))
        if self.reads:
            out["max_reads_of_one_file"] = max(self.reads.values())
        if self.waiting > 0:
            out["seconds_waiting_on_josh"] = self.waiting
        if self.working > 0:
            out["seconds_working"] = self.working
        return out


def _lines(path: Path, start: int, end: Optional[int], facts: Facts) -> Iterator[dict]:
    """The JSON objects of the lines from `start` up to `end`. A broken, oversized or still-being-written line is
    skipped (the last is read on a later pass)."""
    with path.open("rb") as f:
        f.seek(start)
        while end is None or f.tell() < end:
            raw = f.readline(MAX_LINE + 1)
            if not raw:
                break
            if len(raw) > MAX_LINE and not raw.endswith(b"\n"):
                while raw and not raw.endswith(b"\n"):
                    raw = f.readline(MAX_LINE)
                facts.skipped += 1
                continue
            if not raw.endswith(b"\n"):
                break
            try:
                obj = json.loads(raw.decode("utf-8", errors="replace"))
            except ValueError:
                facts.skipped += 1
                continue
            if isinstance(obj, dict):
                facts.lines += 1
                yield obj
            else:
                facts.skipped += 1


def read(path: Path, *, who: str = "josh", start_offset: int = 0, end_offset: Optional[int] = None,
         since: Optional[str] = None, until: Optional[str] = None) -> Facts:
    """The friction counts and usage names of the lines in [start_offset, end_offset), and, when given, with a
    timestamp from `since` to `until` (both `YYYY-MM-DDTHH:MM:SSZ`; a line with no timestamp is kept)."""
    if who not in WHO:
        raise ValueError("who must be one of {}".format(", ".join(WHO)))
    facts = Facts()
    run = _Run(who)
    for line in _lines(path, start_offset, end_offset, facts):
        stamp = _time(line.get("timestamp"))
        if stamp and ((since and stamp < since) or (until and stamp > until)):
            continue
        run.line(line)
    facts.counts = run.finish()
    facts.usage = run.usage
    return facts


def who_for(started_by: Optional[str], is_subagent: bool) -> str:
    """The `who` of a session: a subagent's own, a script's, or (anything else, an unknown starter included) Josh's."""
    if is_subagent:
        return "subagent"
    return "scripted" if started_by in SCRIPTED_STARTERS else "josh"


def instruction_files(folder: Optional[str], claude_home: Path) -> List[Tuple[str, int]]:
    """(label, size in bytes) for the instruction files a session in `folder` would load: the user's CLAUDE.md and
    rules, and each CLAUDE.md, CLAUDE.local.md, .claude/CLAUDE.md and .claude/rules file from the folder up to the
    root. Sizes come from the files as they are now, so this is the size as of the recording, not at the session's
    start. A link to a file already counted (CLAUDE.md pointing at AGENTS.md) is counted once."""
    seen: set = set()
    out: List[Tuple[str, int]] = []
    home = Path.home()

    def add(path: Path) -> None:
        try:
            real = path.resolve()
            if real in seen or not path.is_file():
                return
            size = path.stat().st_size
        except OSError:
            return
        seen.add(real)
        try:
            label = "~/" + str(path.relative_to(home))
        except ValueError:
            label = str(path)
        out.append((label, size))

    def rules(folder_: Path) -> None:
        try:
            for found in sorted(folder_.rglob("*.md"))[:50]:
                add(found)
        except OSError:
            pass

    add(claude_home / "CLAUDE.md")
    rules(claude_home / "rules")
    if folder:
        start = Path(folder)
        for here in [start] + list(start.parents):
            for name in ("CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md"):
                add(here / name)
            rules(here / ".claude" / "rules")
    return out
