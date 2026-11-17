"""Writes made-up Claude Code transcripts for the ledger tests (JP-107). Nothing here is a real conversation.

Each line carries the fields the reader may use, plus message text that the reader must never return.
"""
import json
import os
from pathlib import Path

USER_TEXT = "please summarise the made-up quarterly widget report"
ASSISTANT_TEXT = "the widget report shows sample figures only"


def line(kind, at, session_id="sess-0001", **extra):
    out = {"type": kind, "timestamp": at, "sessionId": session_id, "uuid": "u-" + at, "isSidechain": False}
    if kind == "user":
        out["message"] = {"role": "user", "content": USER_TEXT}
    elif kind == "assistant":
        out["message"] = {"role": "assistant", "content": [{"type": "text", "text": ASSISTANT_TEXT}]}
    out.update(extra)
    return json.dumps(out)


def write(path, lines, mtime=None, newline_at_end=True):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    text = "\n".join(lines) + ("\n" if newline_at_end else "")
    path.write_text(text, encoding="utf-8")
    if mtime is not None:
        os.utime(str(path), (mtime, mtime))
    return path


def append(path, lines, mtime=None):
    with Path(path).open("a", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    if mtime is not None:
        os.utime(str(path), (mtime, mtime))


def plain(cwd, session_id="sess-0001", branch="JP-900/sample-work", start="2026-11-17T09:00:00Z",
          title=None, pr=None, created=()):
    """A short session: two turns, an optional AI title, a created file and a pull request."""
    extra = {"cwd": cwd, "gitBranch": branch}
    lines = [line("user", start, session_id, **extra),
             line("assistant", "2026-11-17T09:01:00Z", session_id, **extra)]
    if title:
        lines.append(line("ai-title", "2026-11-17T09:01:30Z", session_id, aiTitle=title))
    for i, made in enumerate(created):
        lines.append(line("user", "2026-11-17T09:0{}:00Z".format(2 + i), session_id, cwd=cwd, gitBranch=branch,
                          toolUseResult={"type": "create", "filePath": made}))
    if pr:
        lines.append(line("assistant", "2026-11-17T09:06:00Z", session_id, prUrl=pr[0], prRepository=pr[1], cwd=cwd))
    lines.append(line("assistant", "2026-11-17T09:10:00Z", session_id, **extra))
    return lines
