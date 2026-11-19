"""Live reads for the loose-ends check and `ask.py changes --live` (JP-109). Python 3.9, standard library only.

Three questions, asked of the systems that know: is this ticket Done (Jira), what state is this pull request in, and
which pull requests has this branch had (GitHub, through the `gh` command on the laptop). Both are read-only. An answer that cannot be had (no credentials,
no network, no `gh`, a bad reply) is None, never "Done" and never "open": the caller lists it as unchecked.
Nothing here writes, and nothing logs a token or a ticket title.
"""
from __future__ import annotations

import json
import subprocess
import sys
import urllib.parse
from typing import Callable, Dict, List, Optional

sys.dont_write_bytecode = True
from ledger import _repo  # noqa: F401,E402
from ledger import jira_read  # noqa: E402

PR_STATES = ("OPEN", "MERGED", "CLOSED")
FLAG_FIELD = "customfield_10021"  # "Flagged": the same id lib/jira.py reads


class Live:
    """Answers are remembered for the life of the object, so a ticket linked by ten sessions is read once."""

    def __init__(self, fetch: Optional[Callable[[str], Optional[dict]]] = None,
                 run: Callable = subprocess.run, use_jira: bool = True) -> None:
        self._fetch = fetch
        self._use_jira = use_jira
        self._run = run
        self._tickets: Dict[str, Optional[dict]] = {}
        self._prs: Dict[str, Optional[str]] = {}
        self._branches: Dict[str, Optional[List[dict]]] = {}

    def _jira(self) -> Optional[Callable[[str], Optional[dict]]]:
        if self._fetch is None and self._use_jira:
            self._fetch = jira_read.make_fetch()
            if self._fetch is None:
                self._use_jira = False  # no credentials: stop asking
        return self._fetch

    def ticket(self, key: str) -> Optional[dict]:
        """{"status": "In Progress", "done": False, "flagged": False} or None when it could not be read."""
        if key not in self._tickets:
            self._tickets[key] = self._read_ticket(key)
        return self._tickets[key]

    def _read_ticket(self, key: str) -> Optional[dict]:
        fetch = self._jira()
        if fetch is None:
            return None
        issue = fetch("/rest/api/3/issue/{}?fields=status,{}".format(
            urllib.parse.quote(key), FLAG_FIELD))
        fields = (issue or {}).get("fields") or {}
        status = fields.get("status") or {}
        name = status.get("name")
        category = (status.get("statusCategory") or {}).get("key")
        if not isinstance(name, str) or not isinstance(category, str):
            return None
        return {"status": name, "done": category == "done", "flagged": bool(fields.get(FLAG_FIELD))}

    def pr(self, url: str) -> Optional[str]:
        """OPEN, MERGED or CLOSED, or None when it could not be read."""
        if url not in self._prs:
            self._prs[url] = self._read_pr(url)
        return self._prs[url]

    def branch_prs(self, root: str, branch: str) -> Optional[List[dict]]:
        """Every pull request whose head is `branch` in the repository at `root`, as [{"state", "url"}], newest first
        ([] when there is none), or None when it could not be read (JP-174)."""
        key = root + "\n" + branch
        if key not in self._branches:
            self._branches[key] = self._read_branch_prs(root, branch)
        return self._branches[key]

    def _read_branch_prs(self, root: str, branch: str) -> Optional[List[dict]]:
        try:
            result = self._run(["gh", "pr", "list", "--head", branch, "--state", "all", "--json", "state,url",
                                "--limit", "20"], cwd=root, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                               universal_newlines=True, timeout=30)
            if result.returncode != 0:
                return None
            rows = json.loads(result.stdout)
        except (OSError, subprocess.SubprocessError, ValueError, AttributeError):
            return None
        if not isinstance(rows, list):
            return None
        found = []
        for row in rows:
            if not isinstance(row, dict) or row.get("state") not in PR_STATES or not isinstance(row.get("url"), str):
                return None
            found.append({"state": row["state"], "url": row["url"]})
        return found

    def _read_pr(self, url: str) -> Optional[str]:
        try:
            result = self._run(["gh", "pr", "view", url, "--json", "state"], stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, universal_newlines=True, timeout=30)
            if result.returncode != 0:
                return None
            state = json.loads(result.stdout).get("state")
        except (OSError, subprocess.SubprocessError, ValueError, AttributeError):
            return None
        return state if state in PR_STATES else None
