"""The ticket and the desk, as the non-development gates see them (JP-123).

Python 3.9, standard library only. `JiraPort` wraps the shared client (`lib/jira.py`, JP-121) into the five calls the
gates make, and turns every "not confirmed" into a GateError, so a gate never carries on after a write that did not
read back. Tests use a fake with the same five methods and never reach this file's real classes.
"""
from __future__ import annotations

import html
import os
import subprocess
import tempfile
from pathlib import Path
from typing import List

from lib.gate_run import Comment, GateError, Ticket

OUTLOOK_TOOLS = ("~/Development/active/agent_services/agent_tools/outlook_tool.py",
                 "~/Development/active/josh_projects/agent_tools/outlook_tool.py")
TEXT_SUFFIXES = (".md", ".txt", ".csv", ".sql")
MAX_BODY_CHARS = 60000


class JiraPort:
    """Reads and writes one ticket at a time through the shared client. `jira` is a `lib.jira.Jira`."""

    def __init__(self, jira):
        self.jira = jira

    def read(self, key: str) -> Ticket:
        issue = self.jira.get(key)
        if issue is None:
            raise GateError("{} could not be read from Jira".format(key))
        route = self.jira.get_property(key, "josh360.route")
        return Ticket(key, issue["status"], issue["description"], route if isinstance(route, dict) else None)

    def comments(self, key: str) -> List[Comment]:
        rows = self.jira.comments(key)
        if rows is None:
            raise GateError("the comments on {} could not be read from Jira".format(key))
        return [Comment(r["author"], r["body"], r["created"]) for r in rows]

    def comment(self, key: str, text: str) -> None:
        if not self.jira.comment(key, text):
            raise GateError("the comment on {} was not confirmed by Jira".format(key))

    def move(self, key: str, status: str) -> None:
        if not self.jira.transition(key, status):
            raise GateError("{} was not confirmed at {} by Jira".format(key, status))

    def set_flag(self, key: str, on: bool) -> None:
        if not self.jira.set_flag(key, on):
            raise GateError("the flag on {} was not confirmed {} by Jira".format(key, "on" if on else "off"))


def real_port(environ=None) -> JiraPort:
    from lib.jira import Jira   # imported late so tests and gates without Jira never need credentials
    return JiraPort(Jira.from_env(environ))


def _outlook_tool(environ) -> Path:
    """The draft tool: the one JOSH360_OUTLOOK_TOOL names, else the first default that exists under the given HOME."""
    named = environ.get("JOSH360_OUTLOOK_TOOL")
    home = environ.get("HOME")
    candidates = [named] if named else [
        (str(Path(home) / c[2:]) if home and c.startswith("~/") else c) for c in OUTLOOK_TOOLS]
    for candidate in candidates:
        path = Path(candidate).expanduser()
        if path.is_file():
            return path
    raise GateError("no draft tool: outlook_tool.py was not found (set JOSH360_OUTLOOK_TOOL)")


def draft_html(deliverable: Path) -> str:
    """The body of a shared draft: the deliverable's text when it is a small text file, else a note naming the path."""
    if deliverable.suffix.lower() in TEXT_SUFFIXES and deliverable.stat().st_size <= MAX_BODY_CHARS:
        text = deliverable.read_text(encoding="utf-8", errors="replace")
        return '<pre style="white-space:pre-wrap;font-family:inherit">{}</pre>'.format(html.escape(text))
    return "<p>The file is at {}. Attach it before sending.</p>".format(html.escape(str(deliverable)))


def outlook_draft(to: str, subject: str, deliverable: Path, environ=None) -> None:
    """Make an Outlook draft in Josh's own mailbox. It is never sent: the tool's `draft` command only saves it."""
    env = os.environ if environ is None else environ
    tool = _outlook_tool(env)
    with tempfile.TemporaryDirectory() as folder:
        body = Path(folder) / "body.html"
        body.write_text(draft_html(deliverable), encoding="utf-8")
        done = subprocess.run(["/usr/bin/python3", str(tool), "draft", "--to", to, "--subject", subject,
                               "--body-file", str(body), "--no-style"],
                              stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, universal_newlines=True, timeout=120)
    if done.returncode != 0:
        raise GateError("the Outlook draft was not made (exit {})".format(done.returncode))
