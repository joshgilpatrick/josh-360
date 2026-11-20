"""The hook blocks inside one Claude Code transcript (JP-182).

How Claude Code stores each kind of block (seen on Claude Code 2.1.329, 2026-11-20, with real blocking hooks; the
shapes are in docs/proof/2026-11-20/JP-182/README.md):

  PreToolUse (exit 2, JSON "deny", or the old decision "block")
      the tool's tool_result has is_error true and reads "PreToolUse:<Tool> hook error: <message>"; an exit-2 message
      starts "[command hook]: " or "[command hook N]: " (the Nth hook that ran), a JSON reason has no label
  PostToolUse (exit 2 or decision "block"), SubagentStop
      an attachment {"type": "hook_blocking_error", "hookEvent", "hookName": "<Event>[:<Tool>]", "toolUseID",
      "blockingError": {"blockingError": <message>, "command": "command hook N"}}
  Stop
      a system entry, subtype "stop_hook_summary", whose "hookErrors" holds one message per blocking hook (an
      attachment as above is written for some of them only, so the summary is the one counted)
  UserPromptSubmit
      a system entry whose promptSubmitEnding.ending is {"kind": "blocked_by_hook", "reason": <message>}; its content
      ends "Original prompt: <prompt>"

The reader also returns the session's other steps in order (prompts, tool calls and results, assistant text), which
follow.py reads to tell what the agent did next.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Dict, List, Optional, Tuple

TOOL_ERROR = re.compile(r"^(PreToolUse|PostToolUse|PermissionRequest):(\S+) hook (?:blocking )?error(?: from command)?: (.*)\Z",
                        re.S)
LABEL = re.compile(r"^\[([^\]\n]{1,300})\]: (.*)\Z", re.S)
ORIGINAL = re.compile(r"\n\s*Original prompt: (.*)\Z", re.S)
SHORT = 300
KEEP = 2000  # characters kept of a tool result, a text or an input value: months of transcripts must fit in memory


def short(text: str, n: int = SHORT) -> str:
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    return text if len(text) <= n else text[:n - 1] + "…"


def split_label(message: str) -> Tuple[Optional[str], str]:
    """("command hook 2", "the message") from "[command hook 2]: the message". Older Claude Code versions put the
    hook's own command between the brackets, which attribute.py can match directly."""
    m = LABEL.match(message.strip())
    return (m.group(1), m.group(2).strip()) if m else (None, message.strip())


def _trim(data: dict) -> dict:
    return {k: (v[:KEEP] if isinstance(v, str) else v) for k, v in data.items()}


def _text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(str(b.get("text", "")) for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


def describe(tool: Optional[str], data) -> str:
    """What a tool call tried to do, in one short line."""
    if not isinstance(data, dict):
        return short(data)
    for key in ("command", "file_path", "notebook_path", "path", "url", "pattern", "query", "prompt", "description"):
        if data.get(key):
            extra = " ({})".format(data["pattern"]) if key == "path" and data.get("pattern") else ""
            return short(str(data[key]) + extra)
    return short(json.dumps(data, sort_keys=True))


class Transcript:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.steps: List[Dict] = []
        self.bad_lines = 0
        self.error = ""

    @property
    def blocks(self) -> List[Dict]:
        return [s for s in self.steps if s["k"] == "block"]


def read(path: Path) -> Transcript:
    """Never raises. t.error is set when nothing in the file could be read, so the file is reported as skipped and
    never counted as "no blocks"."""
    t = Transcript(path)
    entries = []
    try:
        with path.open(encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue
                try:
                    entry = json.loads(line)
                except ValueError:
                    t.bad_lines += 1
                    continue
                if isinstance(entry, dict):
                    entries.append(entry)
                else:
                    t.bad_lines += 1
    except (OSError, UnicodeDecodeError) as e:
        t.error = "cannot be read ({})".format(e.__class__.__name__)
        return t
    if t.bad_lines and not entries:
        t.error = "no line is JSON ({} lines)".format(t.bad_lines)
        return t
    _walk(t, entries)
    return t


def _base(entry: dict, sidechain_file: bool) -> Dict:
    return {"ts": entry.get("timestamp") or "", "session": entry.get("sessionId") or "",
            "agent": entry.get("agentId") or "", "folder": entry.get("cwd") or "",
            "sidechain": bool(entry.get("isSidechain")) or sidechain_file}


def _walk(t: Transcript, entries: List[dict]) -> None:
    sidechain_file = t.path.parent.name == "subagents"
    calls: Dict[str, Dict] = {}
    summaries = {e.get("toolUseID") for e in entries if e.get("type") == "system"
                 and e.get("subtype") == "stop_hook_summary" and e.get("hookErrors")}
    attached: Dict[str, List[dict]] = {}
    for e in entries:
        a = e.get("attachment") if e.get("type") == "attachment" else None
        if isinstance(a, dict) and a.get("type") == "hook_blocking_error":
            attached.setdefault(str(a.get("toolUseID")), []).append(a)
    last_text = ""
    seen = set()

    def block(entry: dict, **fields) -> None:
        key = (fields["event"], fields.get("tool_use_id"), fields["message"])
        if key in seen:
            return
        seen.add(key)
        step = _base(entry, sidechain_file)
        step.update(k="block", transcript=str(t.path), **fields)
        t.steps.append(step)

    for e in entries:
        kind = e.get("type")
        msg = e.get("message") if isinstance(e.get("message"), dict) else {}
        if kind == "assistant":
            for b in msg.get("content") or []:
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "tool_use":
                    call = dict(_base(e, sidechain_file), k="call", id=b.get("id"), tool=b.get("name"),
                                input=_trim(b["input"]) if isinstance(b.get("input"), dict) else {})
                    calls[str(b.get("id"))] = call
                    t.steps.append(call)
                elif b.get("type") == "text" and str(b.get("text", "")).strip():
                    last_text = str(b["text"])[:KEEP]
                    t.steps.append(dict(_base(e, sidechain_file), k="text", text=last_text))
        elif kind == "user":
            content = msg.get("content")
            results = [b for b in content if isinstance(b, dict) and b.get("type") == "tool_result"] \
                if isinstance(content, list) else []
            for r in results:
                text = _text(r.get("content")) if not isinstance(r.get("content"), str) else r["content"]
                tid = str(r.get("tool_use_id"))
                t.steps.append(dict(_base(e, sidechain_file), k="result", id=tid, error=bool(r.get("is_error")),
                                    text=text[:KEEP]))
                m = TOOL_ERROR.match(text.strip()) if r.get("is_error") else None
                if m:
                    label, message = split_label(m.group(3))
                    call = calls.get(tid, {})
                    block(e, event=m.group(1), tool=m.group(2), label=label, message=message, tool_use_id=tid,
                          attempted=describe(call.get("tool"), call.get("input")), shape="tool_result", call=call or None)
            if not results and not e.get("isMeta") and not e.get("isCompactSummary"):
                text = _text(content)
                if text.strip():
                    t.steps.append(dict(_base(e, sidechain_file), k="prompt", text=text[:KEEP]))
        elif kind == "attachment":
            a = e.get("attachment")
            if not (isinstance(a, dict) and a.get("type") == "hook_blocking_error"):
                continue
            event = str(a.get("hookEvent") or str(a.get("hookName", "")).split(":")[0])
            tid = str(a.get("toolUseID"))
            if event in ("Stop", "SubagentStop") and tid in summaries:
                continue  # counted from the stop summary
            err = a.get("blockingError") if isinstance(a.get("blockingError"), dict) else {}
            label, message = split_label(str(err.get("blockingError", "")))
            name = str(a.get("hookName", ""))
            tool = name.split(":", 1)[1] if ":" in name else None
            call = calls.get(tid, {})
            attempted = describe(call.get("tool"), call.get("input")) if call else \
                "end the turn: " + short(last_text, 160)
            block(e, event=event, tool=tool, label=label or err.get("command"), message=message, tool_use_id=tid,
                  attempted=attempted, shape="attachment", call=call or None)
        elif kind == "system" and e.get("subtype") == "stop_hook_summary":
            tid = str(e.get("toolUseID"))
            known = attached.get(tid, [])
            event = str(known[0].get("hookEvent")) if known else ("SubagentStop" if sidechain_file else "Stop")
            for err in e.get("hookErrors") or []:
                label, message = split_label(str(err))
                if not label:
                    label = next((str((a.get("blockingError") or {}).get("command")) for a in known
                                  if str((a.get("blockingError") or {}).get("blockingError", "")).strip() == message), None)
                block(e, event=event, tool=None, label=label, message=message, tool_use_id=tid,
                      attempted="end the turn: " + short(last_text, 160), shape="stop_hook_summary")
        elif kind == "system":
            ending = ((e.get("promptSubmitEnding") or {}).get("ending") or {}) if isinstance(e.get("promptSubmitEnding"), dict) else {}
            content = str(e.get("content") or "")
            if ending.get("kind") == "blocked_by_hook" or content.startswith("UserPromptSubmit operation blocked by hook"):
                body = content.split("\n", 1)[1] if "\n" in content else ""
                original = ORIGINAL.search(body)
                label, _ = split_label(body[:original.start()] if original else body)
                message = str(ending.get("reason") or split_label(body[:original.start()] if original else body)[1])
                attempted = original.group(1) if original else ""
                block(e, event="UserPromptSubmit", tool=None, label=label, message=message.strip(), tool_use_id=None,
                      attempted=short(attempted), prompt=attempted, shape="prompt_ending")
