"""Made-up tickets, evidence files and fakes for the non-development gate tests (JP-123). No real data, no network.

A gate script's name has a hyphen, so `gate("read-ticket")` loads it by path. Every `run(inputs, deps)` is then called
with `make_deps(...)`, whose ticket, mailer and draft tool are recorders.
"""
from __future__ import annotations

import importlib.util
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

GATES = Path(__file__).resolve().parent.parent / "gates"
sys.path.insert(0, str(GATES))

from lib.gate_run import Comment, GateError, Ticket  # noqa: E402

KEY = "JP-9001"
DESCRIPTION = """**Goal:** answer the question.

**Question:** How many open widgets were filed last quarter, and how many were closed within a week?

**Sources:** the widgets table in the staging copy

**Deliverable format:** a one-page Markdown note with the two counts

**Why:** Josh wants the trend.
"""
EVIDENCE = """---
ticket: {key}
kind: research
phi: {phi}
deliverables:
  - {deliverable}
summary: "{summary}"
sources:
  - type: query
    ref: {key}-query-1.sql
    used_for: "the two counts"
  - type: ticket
    ref: JP-9000
    used_for: "the earlier answer"
assumptions: []
precedent: none
recipient: {recipient}
resolution: "{resolution}"
---
Notes.
"""


def gate(name: str):
    spec = importlib.util.spec_from_file_location("gate_" + name.replace("-", "_"), str(GATES / (name + ".py")))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeTicket:
    """Five calls, all recorded. `fail_on` names a call that raises GateError, as the real port does on no read-back."""

    def __init__(self, description=DESCRIPTION, status="Ready", route=None, comments=None, fail_on=()):
        self.tickets = {KEY: Ticket(KEY, status, description, route if route is not None else {"graph": "non-development"})}
        self.posted = []        # (key, text)
        self.moves = []         # (key, status)
        self.flags = []         # (key, on)
        self.existing = list(comments or [])
        self.fail_on = set(fail_on)

    def _maybe(self, call):
        if call in self.fail_on:
            raise GateError("{} was not confirmed".format(call))

    def read(self, key):
        self._maybe("read")
        if key not in self.tickets:
            raise GateError("{} could not be read".format(key))
        return self.tickets[key]

    def comments(self, key):
        self._maybe("comments")
        return [Comment("Josh", body, "2026-11-17T00:00:00Z") for body in self.existing]

    def comment(self, key, text):
        self._maybe("comment")
        self.posted.append((key, text))
        self.existing.append(text)

    def move(self, key, status):
        self._maybe("move")
        self.moves.append((key, status))
        if key in self.tickets:
            self.tickets[key] = self.tickets[key]._replace(status=status)

    def set_flag(self, key, on):
        self._maybe("flag")
        self.flags.append((key, on))


def make_deps(root: Path, ticket=None, mail_code=0, **extra):
    registry = root / "registry.json"
    registry.write_text(json.dumps({"systems": [{"name": "widgets", "description": "The widget ordering system"}]}))
    mails, drafts = [], []
    deps = SimpleNamespace(
        ticket=ticket or FakeTicket(), artifacts_root=root / "artifacts", registry_path=registry,
        outbox_dir=root / "outbox",
        mailer=lambda args: (mails.append(list(args)), mail_code)[1],
        draft_email=lambda to, subject, path: drafts.append((to, subject, path)),
        mails=mails, drafts=drafts)
    for name, value in extra.items():
        setattr(deps, name, value)
    return deps


def write_artifacts(root: Path, system="widgets", key=KEY, phi=False, summary="Two counts: 40 filed, 31 closed.",
                    recipient="none", resolution="How many were filed and closed? | 40 filed and 31 closed within a week.",
                    queries=True):
    """A deliverable, its evidence file and (by default) the saved query the evidence names. Returns their paths."""
    folder = root / "artifacts" / system
    folder.mkdir(parents=True, exist_ok=True)
    deliverable = folder / (key + "-answer.md")
    deliverable.write_text("# Answer\n40 filed, 31 closed.\n")
    evidence_file = folder / (key + "-evidence.md")
    evidence_file.write_text(EVIDENCE.format(key=key, phi=str(phi).lower(), deliverable=deliverable, summary=summary,
                                             recipient=recipient, resolution=resolution))
    if queries:
        (folder / (key + "-query-1.sql")).write_text("select 1;\n")
    return deliverable, evidence_file


class Case(unittest.TestCase):
    """A fresh temp folder per test, removed afterwards."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="nondev-")).resolve()
        (self.root / "artifacts").mkdir()
        self.addCleanup(shutil.rmtree, str(self.root), True)

    def deps(self, **kwargs):
        return make_deps(self.root, **kwargs)
