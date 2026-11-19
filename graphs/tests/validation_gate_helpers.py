"""Made-up Jira, clock and work folder for the validation graph's gate tests (JP-167). No network, no model.

`Site` is the real Jira client and the real ticket port over the folder-backed fake (`lib/jira_fake.py`), so a gate
under test reads and writes the way it does on the laptop, and the test reads back what Jira would hold.
"""
from __future__ import annotations

import importlib.util
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

GATES = Path(__file__).resolve().parent.parent / "gates"
sys.path.insert(0, str(GATES))

from lib import jira_fake  # noqa: E402
from lib.jira import FLAG_FIELD, Jira  # noqa: E402
from lib.ticket_port import JiraPort  # noqa: E402

UTC = timezone.utc
T0 = datetime(2026, 11, 18, 12, 0, 0, tzinfo=UTC)
KEY = "JP-9001"
BUG_TYPE = "Bug"

YES = """**Validation:**

- Needed: yes
- Starts: at Deployed
- Check every: 1 hour
- Complete when: 3 checks in a row pass
- Give up after: 2 days

```gherkin
@validate
Scenario: The sample job runs clean
  When the watch reads job sample-job
  Then last_exit is 0
```
"""

NO = """**Validation:**

- Needed: no. The change is a document; nothing runs in production.
"""

MANUAL = """**Validation:**

- Needed: yes
- Starts: at Deployed
- Check every: 1 hour
- Complete when: 2 checks in a row pass
- Give up after: 2 days

```gherkin
@validate
Scenario: The sample job runs clean
  When the watch reads job sample-job
  Then last_exit is 0

@validate @manual
Scenario: The summaries read well
  Then Josh confirms that the summaries read as plain English
```
"""


def description(validation: str = YES, goal: str = "Stop the sample job failing.") -> str:
    """A ticket description in marked text, as triage and the validation graph read it."""
    return ("**Goal:** " + goal + "\n\n**Acceptance criteria:**\n\n```gherkin\nFeature: Sample\n  @auto\n"
            "  Scenario: The job exits clean\n    Given the job has run\n    When it ends\n    Then it exits 0\n```\n\n"
            + validation + "\n**Repository:** josh-360\n")


def load_gate(name: str):
    spec = importlib.util.spec_from_file_location("vgate_" + name.replace("-", "_"), str(GATES / (name + ".py")))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FlakyTransport:
    """The fake's transport, except that a call path listed in `fail_once` answers 500 the first time it is made."""

    def __init__(self, inner):
        self.inner = inner
        self.fail_once = []

    def __call__(self, method, url, headers, body):
        for path in list(self.fail_once):
            if path in url:
                self.fail_once.remove(path)
                return 500, b"", {}
        return self.inner(method, url, headers, body)


class Site:
    """A Jira, a ticket port, a clock and a work folder, all under one temporary folder."""

    def __init__(self, tmp, now: datetime = T0):
        self.root = Path(tmp)
        self.folder = self.root / "jira"
        self.folder.mkdir(parents=True, exist_ok=True)
        (self.folder / jira_fake.MARKER).write_text(json.dumps({"statuses": ["Not Started", "Ready", "In Progress",
                                                                              "Deployed", "Done", "Cancelled"]}))
        self.transport = FlakyTransport(jira_fake.FileTransport(self.folder))
        self.jira = Jira("https://x.atlassian.net", "a@b.c", "t", transport=self.transport, sleep=lambda s: None)
        self.clock = now
        self.deps = SimpleNamespace(
            jira=self.jira, ticket=JiraPort(self.jira), work_dir=self.root / "runs" / "run-1" / "work",
            now=lambda: self.clock, run_id="run-1", registry=SimpleNamespace(system_names={"widgets", "josh-360"}))

    # -- the fake's state ---------------------------------------------------------------------------------------
    def _state(self) -> dict:
        return json.loads((self.folder / jira_fake.MARKER).read_text())

    def _save(self, state: dict) -> None:
        (self.folder / jira_fake.MARKER).write_text(json.dumps(state))

    def seed(self, key: str = KEY, status: str = "Deployed", validation: str = YES, labels=("josh-360",),
             issuetype: str = "Task", flagged: bool = False, summary: str = "Fix the sample job") -> str:
        state = self._state()
        state.setdefault("issues", {})[key] = {"key": key, "fields": {
            "summary": summary, "status": {"name": status}, "issuetype": {"name": issuetype},
            "labels": list(labels), "description": description(validation), "issuelinks": [],
            FLAG_FIELD: [{"value": "Impediment"}] if flagged else []}}
        self._save(state)
        return key

    def edit(self, key: str, **fields) -> None:
        state = self._state()
        state["issues"][key]["fields"].update(fields)
        self._save(state)

    def set_status(self, key: str, status: str) -> None:
        self.edit(key, status={"name": status})

    def set_validation(self, key: str, validation: str) -> None:
        self.edit(key, description=description(validation))

    def issue(self, key: str) -> dict:
        return self._state()["issues"][key]["fields"]

    def status(self, key: str) -> str:
        return self.issue(key)["status"]["name"]

    def flagged(self, key: str) -> bool:
        return bool(self.issue(key).get(FLAG_FIELD))

    def keys(self) -> list:
        return sorted(self._state()["issues"])

    def comments(self, key: str) -> list:
        return [c["body"] for c in self._state()["comments"].get(key, [])]

    def comment_texts(self, key: str) -> list:
        from lib import adf
        return [adf.plain(body) if isinstance(body, dict) else str(body) for body in self.comments(key)]

    def calls(self) -> list:
        path = self.folder / jira_fake.CALLS
        return [json.loads(line) for line in path.read_text().splitlines()] if path.is_file() else []

    def writes(self) -> list:
        """The calls that changed something: every call that is not a read."""
        return [c for c in self.calls() if c["method"] != "GET" and not c["path"].endswith("/search/jql")]

    def advance(self, **delta) -> None:
        self.clock = self.clock + timedelta(**delta)
