"""Read a Claude Code transcript's metadata, never its text (JP-107, Task 5). Python 3.9, standard library only.

A transcript is a JSONL file, one JSON object per line. This reads only these fields of each line, and nothing from
`message` (the text of what Josh and the agent said), command output or file contents:

    type, subtype, sessionId, cwd, gitBranch, timestamp, uuid, isSidechain, customTitle, aiTitle, agentName, prUrl,
    prRepository, relocatedCwd, worktreeSession.worktreePath, toolUseResult.filePath, toolUseResult.type

A line that is not valid JSON, or longer than 1 MB, is skipped and counted. A last line with no newline yet is
still being written: it is left unread (the end offset stops before it) and read on the next pass.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

MAX_LINE = 1_000_000
_TIME = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:Z|\+00:00)$")


@dataclass
class Meta:
    session_id: Optional[str] = None
    first_at: Optional[str] = None
    last_at: Optional[str] = None
    cwd: Optional[str] = None
    branch: Optional[str] = None
    worktree: Optional[str] = None
    titles: Dict[str, str] = field(default_factory=dict)  # latest per source: custom, ai, agent-name
    pr_urls: List[Tuple[str, str]] = field(default_factory=list)  # (url, repo)
    files_created: List[str] = field(default_factory=list)
    compactions: int = 0
    turns: int = 0
    is_sidechain: bool = False
    start_offset: int = 0
    end_offset: int = 0
    skipped_lines: int = 0
    lines_read: int = 0


def _time(value: object) -> Optional[str]:
    m = _TIME.match(value) if isinstance(value, str) else None
    return m.group(1) + "Z" if m else None


def _text(value: object, limit: int = 4000) -> Optional[str]:
    return value[:limit] if isinstance(value, str) and value.strip() else None


def _absolute(value: object) -> Optional[str]:
    text = _text(value)
    return text if text and text.startswith("/") else None


TITLE_ORDER = (("custom", "custom"), ("ai", "ai"), ("agent-name", "agent-name"))


def best_title(titles: Dict[str, str]) -> Tuple[Optional[str], Optional[str]]:
    """(title, source): a title Josh set beats one the tool made, which beats the agent's name."""
    for source, _ in TITLE_ORDER:
        if titles.get(source):
            return titles[source], source
    return None, None


def subagent_of(path: Path) -> Optional[Tuple[str, str]]:
    """(parent session id, agent id) for .../<parent>/subagents/agent-*.jsonl, else None."""
    if path.parent.name == "subagents" and path.name.startswith("agent-") and path.suffix == ".jsonl":
        return path.parent.parent.name, path.stem
    return None


def read_meta(path: Path, since_offset: int = 0) -> Meta:
    """The metadata of the lines from since_offset on. end_offset is where the next read should start."""
    meta = Meta(start_offset=since_offset, end_offset=since_offset)
    sidechain = main = 0
    with path.open("rb") as f:
        f.seek(since_offset)
        while True:
            start = f.tell()
            raw = f.readline(MAX_LINE + 1)
            if not raw:
                break
            oversized = len(raw) > MAX_LINE and not raw.endswith(b"\n")
            if oversized:
                while not raw.endswith(b"\n"):  # skip the rest of the line without keeping it
                    raw = f.readline(MAX_LINE)
                    if not raw:
                        break
                if not raw:
                    f.seek(start)  # an unterminated oversized last line: left for a later pass
                    break
                meta.skipped_lines += 1
                meta.end_offset = f.tell()
                continue
            if not raw.endswith(b"\n"):
                break  # still being written
            meta.end_offset = f.tell()
            try:
                line = json.loads(raw.decode("utf-8", errors="replace"))
            except ValueError:
                meta.skipped_lines += 1
                continue
            if not isinstance(line, dict):
                meta.skipped_lines += 1
                continue
            meta.lines_read += 1
            _absorb(meta, line)
            if line.get("isSidechain") is True:
                sidechain += 1
            elif line.get("isSidechain") is False:
                main += 1
    meta.is_sidechain = sidechain > 0 and main == 0
    return meta


def _absorb(meta: Meta, line: dict) -> None:
    stamp = _time(line.get("timestamp"))
    if stamp:
        if meta.first_at is None or stamp < meta.first_at:
            meta.first_at = stamp
        if meta.last_at is None or stamp > meta.last_at:
            meta.last_at = stamp
    if isinstance(line.get("sessionId"), str) and meta.session_id is None:
        meta.session_id = line["sessionId"][:80]
    cwd = _absolute(line.get("cwd")) or (_absolute(line.get("relocatedCwd")) if not line.get("cwd") else None)
    if cwd:
        meta.cwd = cwd
    branch = _text(line.get("gitBranch"), 250)
    if branch and branch != "HEAD":
        meta.branch = branch
    for key, source in (("customTitle", "custom"), ("aiTitle", "ai"), ("agentName", "agent-name")):
        title = _text(line.get(key), 400)
        if title:
            meta.titles[source] = title
    url = _text(line.get("prUrl"), 500)
    if url:
        pair = (url, _text(line.get("prRepository"), 200) or "")
        if pair not in meta.pr_urls:
            meta.pr_urls.append(pair)
    worktree = line.get("worktreeSession")
    if isinstance(worktree, dict) and _absolute(worktree.get("worktreePath")):
        meta.worktree = _absolute(worktree["worktreePath"])
    result = line.get("toolUseResult")
    if isinstance(result, dict) and result.get("type") == "create":
        made = _absolute(result.get("filePath"))
        if made and made not in meta.files_created:
            meta.files_created.append(made)
    if line.get("type") == "system" and line.get("subtype") == "compact_boundary":
        meta.compactions += 1
    elif line.get("type") == "assistant":
        meta.turns += 1
