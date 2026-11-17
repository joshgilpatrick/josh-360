"""The shape every non-development gate shares (JP-123): inputs in, one `(outcome, outputs, summary)` out.

Python 3.9, standard library only. A gate script is a `run(inputs, deps)` function plus a four-line `main`:

    def run(inputs, deps): ... return "done", {"key": value}, "one line for the ledger"
    if __name__ == "__main__":
        execute(run, ["ticket_key", ...])

`run` is pure apart from what it does through `deps` (the ticket, the file system, the mailer), so tests call it with
fakes and no network. `execute` builds the real `deps`, so a gate that never touches Jira needs no credentials.
Anything a gate cannot finish raises GateError: the walker sees exit 1 and stops the run, and never retries it.
"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Callable, Dict, List, NamedTuple, Optional, Sequence, Tuple

from lib import patient_data
from lib.artifacts import artifacts_root
from lib.gate_io import fail, finish, read_inputs

Result = Tuple[str, Optional[dict], Optional[str]]


class GateError(Exception):
    """A gate cannot complete. The message says what, and never quotes ticket or deliverable content."""


class Ticket(NamedTuple):
    key: str
    status: str
    description: str          # plain text
    route: Optional[dict]     # the ticket's josh360.route property, or None


class Comment(NamedTuple):
    author: str
    body: str                 # plain text
    created: str


def screened(text: str) -> str:
    """The text, when the patient-data screen for outside writes finds nothing; otherwise GateError naming the kinds."""
    problems = patient_data.scan(text, None, False, external=True)
    if problems:
        raise GateError("not written: the patient-data screen found " + ", ".join(problems))
    return text


def say(ticket_port, key: str, text: str, once: bool = False) -> bool:
    """Comment on a ticket after the screen. With `once`, skip it when the newest comment already says exactly this
    (so a gate run again after a crash does not repeat itself). Returns True when it posted."""
    screened(text)
    if once:
        existing = ticket_port.comments(key)
        if existing and existing[-1].body.strip() == text.strip():
            return False
    ticket_port.comment(key, text)
    return True


def mailer_command(environ=None) -> List[str]:
    env = os.environ if environ is None else environ
    desk_bin = Path(env.get("DESK_BIN") or "~/.local/share/agent-services-desk/bin").expanduser()
    return ["/usr/bin/python3", str(desk_bin / "desk_mailer.py")]


def run_command(argv: Sequence[str]) -> int:
    """Run a command and return its exit code. Output is not kept: it may hold content."""
    return subprocess.call(list(argv), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


class Deps:
    """What a gate reaches the world through. Tests build their own with the same attribute names."""

    def __init__(self, environ=None):
        self.environ = os.environ if environ is None else environ
        self._ticket = None
        self.artifacts_root = artifacts_root(self.environ)
        self.registry_path = Path(__file__).resolve().parents[3] / "conventions" / "registry.json"
        self.mailer = lambda args: run_command(mailer_command(self.environ) + list(args))
        self.outbox_dir = Path("~/Library/Application Support/agent-services-desk/outbox").expanduser()

    @property
    def jira(self):
        """The shared Jira client (lib/jira.py), built on first use so a gate that needs no Jira needs no credentials."""
        if getattr(self, "_jira", None) is None:
            from lib.jira import Jira   # imported late, like `ticket`
            self._jira = Jira.from_env(self.environ)
        return self._jira

    @property
    def registry(self):
        from lib.triage.registry import Registry
        return Registry.load(self.registry_path)

    def signing_session(self, run_id):
        """The session that did the run's sign-off step, from the ledger (None when it was not recorded)."""
        from lib.triage import runs
        return runs.signing_session(run_id)

    @property
    def ticket(self):
        if self._ticket is None:
            from lib.ticket_port import real_port   # imported late: a gate that needs no Jira never loads it
            self._ticket = real_port(self.environ)
        return self._ticket

    def draft_email(self, to: str, subject: str, body_path: Path) -> None:
        from lib.ticket_port import outlook_draft
        outlook_draft(to, subject, body_path, self.environ)


def execute(run: Callable[[Dict[str, Optional[str]], object], Result], names: List[str]) -> None:
    """The body of every gate script's `__main__`."""
    inputs = read_inputs(names)
    try:
        outcome, outputs, summary = run(inputs, Deps())
    except GateError as exc:
        fail(str(exc))
    except Exception as exc:   # a bug or a Jira outage: stop the run, say which kind, never the content
        fail("{}: {}".format(exc.__class__.__name__, str(exc)[:160]))
    finish(outcome, outputs, summary)


def need(inputs: Dict[str, Optional[str]], name: str) -> str:
    value = inputs.get(name)
    if value is None or not value.strip():
        raise GateError("the input '{}' was not given".format(name))
    return value.strip()

