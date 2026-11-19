"""Made-up Jira reads and a made-up clock for the validation collector and watch tests (JP-166). No network."""
from __future__ import annotations

from typing import Dict, List, Optional


class FakeJiraReader:
    """The read side of the Jira client a collector or the watch uses: `site`, `search`, `get` and `exists`, all recorded.

    `issues` maps a key to its status name (a status named Done, or Cancelled, sets the category the way Jira does).
    `search_fails` and `read_fails` make the matching calls answer None, as the real client does when Jira cannot
    answer. `search_rows` is what every search returns.
    """

    site = "https://example.atlassian.net"

    def __init__(self, issues: Optional[Dict[str, str]] = None):
        self.issues: Dict[str, str] = dict(issues or {})
        self.search_rows: List[dict] = []
        self.search_fails = False
        self.read_fails = False
        self.calls: List[tuple] = []

    def search(self, jql, fields=None, limit=100):
        self.calls.append(("search", jql, limit))
        if self.search_fails:
            return None
        return list(self.search_rows)[:limit]

    def get(self, key, fields=None):
        self.calls.append(("get", key))
        if self.read_fails or key not in self.issues:
            return None
        status = self.issues[key]
        return {"key": key, "status": status,
                "status_category": "done" if status in ("Done", "Cancelled") else "indeterminate"}

    def exists(self, key):
        self.calls.append(("exists", key))
        if self.read_fails:
            return None
        return key in self.issues
