"""Made-up Claude Code transcripts for JP-182, in the shapes Claude Code 2.1.329 wrote when real hooks blocked
(docs/proof/2026-11-20/JP-182/README.md). Every value here is invented."""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Dict, List, Optional

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))
sys.path.insert(0, str(REPO))
import hook_blocks  # noqa: E402
from hook_blocks_lib import inventory  # noqa: E402

FOLDER = "/made/up/project"


class Session:
    """Builds one transcript, entry by entry, with times one second apart from 2026-11-19T10:00:00Z."""

    def __init__(self, sid: str = "sess-0001", folder: str = FOLDER, agent: Optional[str] = None,
                 start: int = 0) -> None:
        self.sid, self.folder, self.agent = sid, folder, agent
        self.entries: List[Dict] = []
        self.clock = start
        self.n = 0

    def _ts(self) -> str:
        self.clock += 1
        return "2026-11-19T10:{:02d}:{:02d}.000Z".format(self.clock // 60, self.clock % 60)

    def _add(self, entry: Dict) -> Dict:
        entry.update(sessionId=self.sid, cwd=self.folder, timestamp=self._ts(), isSidechain=bool(self.agent))
        if self.agent:
            entry["agentId"] = self.agent
        self.entries.append(entry)
        return entry

    def prompt(self, text: str) -> None:
        self._add({"type": "user", "message": {"role": "user", "content": text}})

    def text(self, text: str) -> None:
        self._add({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}})

    def call(self, tool: str, data: Dict) -> str:
        self.n += 1
        tid = "toolu_{:04d}".format(self.n)
        self._add({"type": "assistant", "message": {"role": "assistant", "content": [
            {"type": "tool_use", "id": tid, "name": tool, "input": data}]}})
        return tid

    def result(self, tid: str, text: str, error: bool = False) -> None:
        self._add({"type": "user", "message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": tid, "content": text, "is_error": error}]}})

    def bash(self, command: str, output: str = "ok") -> str:
        tid = self.call("Bash", {"command": command})
        self.result(tid, output)
        return tid

    def pre_block(self, tool: str, data: Dict, message: str, label: Optional[str] = "command hook") -> str:
        """A PreToolUse block: exit 2 when label is set, a JSON deny when it is None."""
        tid = self.call(tool, data)
        body = "[{}]: {}\n".format(label, message) if label else message
        self.result(tid, "PreToolUse:{} hook error: {}".format(tool, body), error=True)
        return tid

    def post_block(self, command: str, message: str) -> str:
        tid = self.bash(command)
        self._add({"type": "attachment", "attachment": {
            "type": "hook_blocking_error", "hookName": "PostToolUse:Bash", "toolUseID": tid, "hookEvent": "PostToolUse",
            "blockingError": {"blockingError": message, "command": "command hook"}}})
        return tid

    def stop_block(self, *messages: str, attach_first: bool = True) -> None:
        tid = "stop-{}".format(self.clock)
        self._add({"type": "user", "isMeta": True, "message": {"role": "user",
                                                               "content": "Stop hook feedback:\n" + messages[0]}})
        event = "SubagentStop" if self.agent else "Stop"
        if attach_first:
            self._add({"type": "attachment", "attachment": {
                "type": "hook_blocking_error", "hookName": event, "toolUseID": tid, "hookEvent": event,
                "blockingError": {"blockingError": messages[0], "command": "command hook 1"}}})
        if not self.agent:
            self._add({"type": "system", "subtype": "stop_hook_summary", "toolUseID": tid,
                       "hookCount": len(messages), "hookErrors": list(messages), "level": "suggestion"})

    def prompt_block(self, prompt: str, message: str, label: Optional[str] = None) -> None:
        head = "[{}]: {}\n".format(label, message) if label else message
        self._add({"type": "system", "subtype": "informational", "level": "warning", "preventContinuation": True,
                   "content": "UserPromptSubmit operation blocked by hook:\n{}\n\nOriginal prompt: {}".format(head, prompt),
                   "promptSubmitEnding": {"ending": {"kind": "blocked_by_hook", "reason": message}, "promptKept": False}})

    def write(self, projects: Path, parent: Optional[str] = None) -> Path:
        folder = projects / self.folder.strip("/").replace("/", "-")
        if self.agent:
            path = folder / (parent or self.sid) / "subagents" / "agent-{}.jsonl".format(self.agent)
        else:
            path = folder / "{}.jsonl".format(self.sid)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("".join(json.dumps(e) + "\n" for e in self.entries), encoding="utf-8")
        return path


def settings(*hooks: Dict) -> Dict:
    """{"hooks": ...} from (event, matcher, command) dicts."""
    out: Dict[str, List] = {}
    for h in hooks:
        out.setdefault(h["event"], []).append({"matcher": h.get("matcher", ""), "hooks": [
            {"type": "command", "command": h["command"]}]})
    return {"hooks": out, "enabledPlugins": {}}


class HookBlocksCase(unittest.TestCase):
    """A made-up laptop: HOME, ~/.claude (settings, projects), ~/.josh-360 (logs, a small laptop copy)."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="josh360-hookblocks-"))
        self.home = self.tmp / "home"
        self.claude = self.home / ".claude"
        self.projects = self.claude / "projects"
        self.j360 = self.home / ".josh-360"
        self.scripts = self.tmp / "hooks-src"
        for p in (self.projects, self.j360 / "logs", self.j360 / "repo" / "hooks", self.scripts):
            p.mkdir(parents=True)
        self.env = {k: os.environ.get(k) for k in ("HOME", "JOSH360_HOME")}
        os.environ["HOME"] = str(self.home)
        os.environ["JOSH360_HOME"] = str(self.j360)
        self.managed = inventory.MANAGED
        inventory.MANAGED = []

    def tearDown(self) -> None:
        inventory.MANAGED = self.managed
        for k, v in self.env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(str(self.tmp), ignore_errors=True)

    def script(self, name: str, body: str) -> str:
        """A hook script whose source holds its block message, so it can be matched by message text."""
        path = self.scripts / name
        path.write_text("#!/usr/bin/env python3\n" + body + "\n", encoding="utf-8")
        path.chmod(0o755)
        return str(path)

    def josh360_hook(self, event: str, name: str, body: str = "exit 0") -> Path:
        path = self.j360 / "repo" / "hooks" / event / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("#!/bin/bash\n" + body + "\n", encoding="utf-8")
        path.chmod(0o755)
        return path

    def user_settings(self, data: Dict) -> None:
        (self.claude / "settings.json").write_text(json.dumps(data), encoding="utf-8")

    def run_cli(self, *argv: str):
        import contextlib
        import datetime
        import io
        out = io.StringIO()
        now = datetime.datetime(2026, 11, 20, 12, 0, 0, tzinfo=datetime.timezone.utc)
        with contextlib.redirect_stdout(out):
            code = hook_blocks.main(["--claude-home", str(self.claude)] + list(argv), now=now)
        folder = self.j360 / "reviews" / "hook-blocks"
        md = folder / "hook-blocks-2026-11-20.md"
        data = json.loads((folder / "hook-blocks-2026-11-20.json").read_text()) if code == 0 else None
        return code, out.getvalue(), (md.read_text() if code == 0 else ""), data

    @staticmethod
    def row(data: Dict, hook_id: str) -> Dict:
        found = [r for r in data["hooks"] if r["id"] == hook_id]
        assert found, "no row {} in {}".format(hook_id, [r["id"] for r in data["hooks"]])
        return found[0]
