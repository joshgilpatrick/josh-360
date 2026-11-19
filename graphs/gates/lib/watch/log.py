"""The check log: one JSON object per line, written only by the watch's wait step (JP-166).

`round-3.json` (the watch file) has its log beside it, `round-3.checks.jsonl`. A line is added with one write of one
line ending in a newline, so a crash leaves at worst a torn last line; `read` skips any line that is not a JSON object,
and the next `append` starts on a fresh line. Python 3.9, standard library only.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import List, Optional


def path_for(watch_file: Path) -> Path:
    return watch_file.with_name(watch_file.stem + ".checks.jsonl")


def read(path: Path) -> List[dict]:
    """Every line that is a JSON object, in order. A missing file is an empty log."""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return []
    lines = []
    for raw in text.splitlines():
        try:
            parsed = json.loads(raw)
        except ValueError:
            continue
        if isinstance(parsed, dict):
            lines.append(parsed)
    return lines


def append(path: Path, line: dict) -> None:
    """Add one line. When the file does not end in a newline (a torn write), the new line goes on a fresh one."""
    data = (json.dumps(line, sort_keys=True) + "\n").encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with open(str(path), "rb") as existing:
            existing.seek(0, os.SEEK_END)
            if existing.tell() > 0:
                existing.seek(-1, os.SEEK_END)
                if existing.read(1) != b"\n":
                    data = b"\n" + data
    except FileNotFoundError:
        pass
    with open(str(path), "ab") as out:
        out.write(data)
        out.flush()
        os.fsync(out.fileno())


def last(lines: List[dict], kind: str) -> Optional[dict]:
    for line in reversed(lines):
        if line.get("kind") == kind:
            return line
    return None
