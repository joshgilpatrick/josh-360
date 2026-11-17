"""GitHub for the development gates (JP-115): one small class over the `gh` command. Python 3.9, standard library only.

Every call has a 60-second timeout. A failed call raises GitHubError carrying the first line of `gh`'s own error and
nothing else: never an empty answer standing in for "could not read", never a pull request's text. Two exit codes are
not failures: `gh pr checks` exits 8 when some checks are pending (it still prints them), and "no checks reported"
means none have started.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Dict, List, NamedTuple, Optional, Tuple
from urllib.parse import quote

GH_TIMEOUT = 60

TRIGGER = "review:needs-agent-audit"
IN_PROGRESS = "review:audit-in-progress"
CHANGES = "review:changes-requested"
READY = "review:ready-for-human"
BLOCKED = "review:audit-blocked"

# The colour and description action-triage uses for each, so a label made here is the label it expects.
REVIEW_LABELS: Dict[str, Tuple[str, str]] = {
    TRIGGER: ("5319E7", "PR requires autonomous audit session"),
    IN_PROGRESS: ("FBCA04", "Autonomous PR audit is running"),
    CHANGES: ("D93F0B", "Audit findings require author follow-up"),
    READY: ("0E8A16", "Audit complete; ready for human review"),
    BLOCKED: ("D93F0B", "PR-native audit session needs human input to proceed"),
}

PR_FIELDS = "number,url,state,labels,headRefOid,headRefName,baseRefName,mergeCommit"
PR_URL = re.compile(r"^https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/pull/([0-9]+)/?$")


class GitHubError(Exception):
    """A `gh` call failed. The message is its first line of stderr."""


class PullRequest(NamedTuple):
    number: int
    url: str
    state: str          # OPEN, MERGED or CLOSED
    head_sha: str
    head_ref: str
    base_ref: str
    labels: List[str]
    merge_commit: str   # "" until it merges


class Check(NamedTuple):
    name: str
    bucket: str         # pass, fail, pending, skipping or cancel
    started: str


class PrComment(NamedTuple):
    author: str
    body: str
    created: str


def parse_pr_url(url: str) -> Tuple[str, int]:
    """The repository and the number, both read from the one URL."""
    found = PR_URL.match((url or "").strip())
    if not found:
        raise GitHubError("not a pull request URL on github.com")
    return found.group(1), int(found.group(2))


def _first_line(text: str) -> str:
    lines = (text or "").strip().splitlines()
    return (lines[0] if lines else "no output")[:160]


def _json(text: str, what: str):
    try:
        return json.loads(text)
    except ValueError:
        raise GitHubError("{} was not readable".format(what))


class GitHub:
    def __init__(self, repo: str, environ=None, runner=subprocess.run):
        self.repo = repo
        self.environ = os.environ if environ is None else environ
        self.runner = runner

    def _gh(self, *args: str, stdin: Optional[str] = None, ok: Tuple[int, ...] = (0,),
            quiet_if: Tuple[str, ...] = ()) -> Tuple[int, str]:
        """Run `gh`. Returns (exit code, stdout). Raises unless the exit code is in `ok` or stderr/stdout holds one of
        the `quiet_if` phrases (the absent-is-fine cases)."""
        try:
            extra = {"input": stdin} if stdin is not None else {"stdin": subprocess.DEVNULL}   # never wait on a prompt
            done = self.runner(["gh"] + list(args), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               universal_newlines=True, timeout=GH_TIMEOUT, env=dict(self.environ), **extra)
        except (OSError, subprocess.SubprocessError) as exc:
            raise GitHubError("gh could not run: {}".format(exc.__class__.__name__))
        if done.returncode in ok:
            return done.returncode, done.stdout or ""
        said = (done.stderr or "") + (done.stdout or "")
        if any(phrase in said for phrase in quiet_if):
            return done.returncode, ""
        raise GitHubError("gh {} failed: {}".format(args[0] if args else "", _first_line(done.stderr or done.stdout)))

    @staticmethod
    def _pull(row: dict) -> PullRequest:
        merge = row.get("mergeCommit") or {}
        return PullRequest(int(row["number"]), str(row.get("url") or ""), str(row.get("state") or ""),
                           str(row.get("headRefOid") or ""), str(row.get("headRefName") or ""),
                           str(row.get("baseRefName") or ""),
                           [str(label.get("name")) for label in row.get("labels") or []],
                           str(merge.get("oid") or ""))

    def pr(self, number: int) -> PullRequest:
        _, out = self._gh("pr", "view", str(number), "--repo", self.repo, "--json", PR_FIELDS)
        row = _json(out, "the pull request")
        if not isinstance(row, dict) or "number" not in row:
            raise GitHubError("the pull request was not readable")
        return self._pull(row)

    def open_pr_for(self, branch: str) -> Optional[PullRequest]:
        _, out = self._gh("pr", "list", "--repo", self.repo, "--head", branch, "--state", "open", "--json", PR_FIELDS)
        rows = _json(out, "the pull request list")
        if not isinstance(rows, list):
            raise GitHubError("the pull request list was not readable")
        return self._pull(rows[0]) if rows else None

    def create_pr(self, head: str, base: str, title: str, body: str) -> PullRequest:
        with tempfile.TemporaryDirectory() as folder:
            body_file = Path(folder) / "body.md"
            body_file.write_text(body, encoding="utf-8")
            _, out = self._gh("pr", "create", "--repo", self.repo, "--head", head, "--base", base, "--title", title,
                              "--body-file", str(body_file))
        urls = [line for line in out.splitlines() if line.strip().startswith("https://")]
        if not urls:
            raise GitHubError("the pull request was made but its address was not shown")
        repo, number = parse_pr_url(urls[-1])
        return self.pr(number)

    def comments(self, number: int) -> List[PrComment]:
        _, out = self._gh("api", "--paginate", "repos/{}/issues/{}/comments".format(self.repo, number))
        decoder, rows, at, text = json.JSONDecoder(), [], 0, out.strip()
        while at < len(text):   # --paginate prints one array per page, back to back
            try:
                page, at = decoder.raw_decode(text, at)
            except ValueError:
                raise GitHubError("the comments were not readable")
            if not isinstance(page, list):
                raise GitHubError("the comments were not readable")
            rows.extend(page)
            while at < len(text) and text[at].isspace():
                at += 1
        return [PrComment(str((r.get("user") or {}).get("login") or ""), str(r.get("body") or ""),
                          str(r.get("created_at") or "")) for r in rows]

    def comment(self, number: int, body: str) -> None:
        self._gh("api", "repos/{}/issues/{}/comments".format(self.repo, number), "--input", "-",
                 stdin=json.dumps({"body": body}))

    def ensure_labels(self) -> None:
        _, out = self._gh("label", "list", "--repo", self.repo, "--limit", "200", "--json", "name")
        rows = _json(out, "the label list")
        have = {str(row.get("name")) for row in rows} if isinstance(rows, list) else set()
        for name, (color, description) in REVIEW_LABELS.items():
            if name not in have:
                self._gh("label", "create", name, "--repo", self.repo, "--color", color, "--description", description)

    def add_label(self, number: int, label: str) -> None:
        self._gh("api", "repos/{}/issues/{}/labels".format(self.repo, number), "--input", "-",
                 stdin=json.dumps({"labels": [label]}))

    def remove_label(self, number: int, label: str) -> None:
        self._gh("api", "-X", "DELETE", "repos/{}/issues/{}/labels/{}".format(self.repo, number, quote(label, safe="")),
                 quiet_if=("HTTP 404", "Label does not exist"))

    def checks(self, number: int) -> List[Check]:
        code, out = self._gh("pr", "checks", str(number), "--repo", self.repo, "--json", "name,bucket,startedAt",
                             ok=(0, 8), quiet_if=("no checks reported",))
        if not out.strip():
            if code in (0, 8):
                raise GitHubError("the checks were not readable")
            return []
        rows = _json(out, "the checks")
        if not isinstance(rows, list):
            raise GitHubError("the checks were not readable")
        return [Check(str(r.get("name") or ""), str(r.get("bucket") or ""), str(r.get("startedAt") or "")) for r in rows]

    def merge_squash(self, number: int, head_sha: str) -> None:
        self._gh("pr", "merge", str(number), "--repo", self.repo, "--squash", "--match-head-commit", head_sha)

    def delete_branch(self, branch: str) -> None:
        self._gh("api", "-X", "DELETE", "repos/{}/git/refs/heads/{}".format(self.repo, quote(branch, safe="/")),
                 quiet_if=("Reference does not exist", "HTTP 404", "HTTP 422"))
