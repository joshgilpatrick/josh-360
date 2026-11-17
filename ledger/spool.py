"""The hook spool (JP-107, Task 3). Python 3.9, standard library only.

Two hooks, SessionStart and SessionEnd, append one JSON line each to a spool file and nothing else. They never open
the ledger and never call a model, so they stay fast and cannot stop a session. The recorder job
(ledger/record.py) reads the spool on its next pass. A line holds exactly these keys, and no prompt, message or
transcript text:

    event, at, session_id, transcript_path, cwd, source, reason, started_by

`source` is the SessionStart input's source (startup, resume, clear, compact), `reason` the SessionEnd input's
reason. `started_by` is worked out from the environment by the ordered rules in ledger/codes.json (`started_by_env`),
the first matching rule winning, so an Agent Manager session is recorded as `agent-manager` and not `daemon`.
"""
from __future__ import annotations

import datetime
import json
import os
import re
import sys
from pathlib import Path
from typing import Dict, List, Mapping, Optional, TextIO, Tuple

sys.dont_write_bytecode = True
from ledger import _repo  # noqa: E402
from laptop import common  # noqa: E402

CODES = _repo.ROOT / "ledger" / "codes.json"
KEYS = ("event", "at", "session_id", "transcript_path", "cwd", "source", "reason", "started_by")
EVENTS = ("SessionStart", "SessionEnd")
SESSION_ID = re.compile(r"^[A-Za-z0-9._-]{1,80}$")
SPOOL_FILE = re.compile(r"^\d{4}-\d{2}-\d{2}\.jsonl$")
MAX_TEXT = 1000


def spool_dir() -> Path:
    return common.state_dir() / "ledger-spool"


def started_by(env: Mapping[str, str], codes: Path = CODES) -> str:
    """Who started the session, from the ordered rules in codes.json. The first match wins, else the default."""
    rules = json.loads(codes.read_text(encoding="utf-8"))["started_by_env"]
    for rule in rules["rules"]:
        value = env.get(rule["env"])
        if value is not None and value != "" and rule.get("equals", value) == value:
            return rule["started_by"]
    return rules["default"]


def write_line(folder: Path, line: Dict[str, object], now: str) -> None:
    """One JSON line, in <folder>/<YYYY-MM-DD>.jsonl, written with one write call to a file opened in append mode, so
    two hooks firing together do not interleave."""
    folder.mkdir(parents=True, exist_ok=True)
    data = (json.dumps(line, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    fd = os.open(str(folder / (now[:10] + ".jsonl")), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        os.write(fd, data)
    finally:
        os.close(fd)


def append(event: str, payload: Dict[str, object], now: str, folder: Optional[Path] = None) -> None:
    """A SessionStart or SessionEnd line: exactly the keys in KEYS and nothing else."""
    line = {k: payload.get(k) for k in KEYS}
    line["event"], line["at"] = event, now
    write_line(folder or spool_dir(), line, now)


def read_since(folder: Path, mark: Dict[str, object]) -> Tuple[List[Dict[str, object]], Dict[str, object]]:
    """The spool lines written since `mark`, and the new mark ({"file": name, "offset": bytes}).

    A last line with no newline yet is still being written: it is left for the next pass, and the mark stops before
    it. A line that is not valid JSON is skipped.
    """
    files = sorted(p.name for p in folder.iterdir() if SPOOL_FILE.match(p.name)) if folder.is_dir() else []
    start_file = str(mark.get("file") or "")
    offset = int(mark.get("offset") or 0)
    lines: List[Dict[str, object]] = []
    new_mark = {"file": start_file, "offset": offset}
    for name in files:
        if name < start_file:
            continue
        begin = offset if name == start_file else 0
        raw = (folder / name).read_bytes()[begin:]
        consumed = raw.rfind(b"\n") + 1
        for chunk in raw[:consumed].split(b"\n"):
            if not chunk.strip():
                continue
            try:
                parsed = json.loads(chunk.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                continue
            if isinstance(parsed, dict):
                lines.append(parsed)
        new_mark = {"file": name, "offset": begin + consumed}
    return lines, new_mark


def _text(value: object) -> Optional[str]:
    return value[:MAX_TEXT] if isinstance(value, str) and value else None


def _log(message: str) -> None:
    try:
        common.logs_dir().mkdir(parents=True, exist_ok=True)
        with (common.logs_dir() / "hooks.log").open("a", encoding="utf-8") as f:
            f.write("{} ledger-spool {}\n".format(common.now_utc(), message))
    except OSError:
        pass


def main(event: str, stdin: TextIO) -> int:
    """The hook body. Always 0: a broken spool must never stop a session. Errors are logged without the input."""
    try:
        if event not in EVENTS or os.environ.get("JOSH360_INTERNAL_CALL") == "1":
            return 0  # a call Josh 360 makes itself (JP-108) is not a session to record
        data = json.loads(stdin.read())
        session_id = data.get("session_id") if isinstance(data, dict) else None
        if not isinstance(session_id, str) or not SESSION_ID.match(session_id):
            return 0
        append(event, {
            "session_id": session_id,
            "transcript_path": _text(data.get("transcript_path")),
            "cwd": _text(data.get("cwd")),
            "source": _text(data.get("source")) if event == "SessionStart" else None,
            "reason": _text(data.get("reason")) if event == "SessionEnd" else None,
            "started_by": started_by(os.environ),
        }, common.now_utc())
    except Exception as e:  # noqa: BLE001  (a hook fails open)
        _log("{} failed: {}".format(event, type(e).__name__))
    return 0
