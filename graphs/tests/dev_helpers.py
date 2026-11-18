"""Made-up specs, tickets and (from Task 7) scratch repositories and fakes for the development gates' tests (JP-115).

Nothing here is real data, and nothing reaches Jira, GitHub or the network. Python 3.9, standard library only.
"""
from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Dict, List, Optional, Tuple

from nondev_helpers import Case, FakeTicket, gate, make_deps  # noqa: F401  (re-exported for the dev tests)

from lib import dev_github  # noqa: E402
from lib.dev_github import GitHubError, PrComment, PullRequest, Check  # noqa: E402

KEY = "JP-9002"

DESCRIPTION = """**Goal:** Label the widget.

**Acceptance criteria:**

```gherkin
Feature: The widget label

  @auto
  Scenario: A widget is labelled
    Given a widget
    When it is built
    Then it carries a label

  @manual
  Scenario: The label reads well on a real screen
    Given a widget on a real screen
    Then a person can read it
```

**Repository:** widgets

**Open questions:**

- Answered: which colour? Blue.
"""

SPEC = {
    "ticket": KEY,
    "summary": "Adds a label to the widget and checks it reads back.",
    "definition_of_done": [
        {"id": "DOD-1", "rule": "No placeholders: no TODO, FIXME or stub bodies in files this plan changed."},
        {"id": "DOD-2", "rule": "Every item in a phase's task list is implemented in full."},
        {"id": "DOD-3", "rule": "Tests assert the behaviour the phase names."},
        {"id": "DOD-4", "rule": "Every check of every phase ran and passed on the final tree."},
        {"id": "DOD-5", "rule": "Files changed are the files the phases name."},
    ],
    "phases": [
        {"id": "p1", "title": "The widget file", "task": ["Create widget.txt", "Put the word widget in it"],
         "checks": ["test -f widget.txt"], "files": ["widget.txt"]},
        {"id": "p2", "title": "The label", "task": ["Add the label line to widget.txt"],
         "checks": ["grep -q label widget.txt"], "files": ["widget.txt", "README.md"]},
    ],
    "scenarios": [
        {"name": "A widget is labelled", "tag": "@auto", "proved_by": "p2.check.1"},
        {"name": "The label reads well on a real screen", "tag": "@manual", "proved_by": "docs/proof/widget/README.md"},
    ],
}


def spec_copy(**changes) -> dict:
    """A deep copy of SPEC with top-level fields replaced."""
    spec = copy.deepcopy(SPEC)
    spec.update(changes)
    return spec


def write_spec(work_dir: Path, spec: Optional[dict] = None) -> Path:
    """Write the spec in YAML's JSON form to <work_dir>/spec.yaml and return the path."""
    work_dir.mkdir(parents=True, exist_ok=True)
    path = work_dir / "spec.yaml"
    path.write_text(json.dumps(SPEC if spec is None else spec, indent=1), encoding="utf-8")
    return path


def _run(cwd: Path, *args: str) -> str:
    done = subprocess.run(list(args), cwd=str(cwd), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          universal_newlines=True, check=True)
    return done.stdout.strip()


def scratch_repo(tmp: Path, name: str = "widgets") -> Tuple[Path, Path]:
    """A bare `origin` and a clone of it on `main` with one commit. Returns (origin, clone)."""
    origin = Path(tmp) / (name + "-origin.git")
    clone = Path(tmp) / name
    _run(Path(tmp), "git", "init", "--bare", "-b", "main", str(origin))
    _run(Path(tmp), "git", "clone", str(origin), str(clone))
    _run(clone, "git", "config", "user.name", "Test")
    _run(clone, "git", "config", "user.email", "test@example.com")
    _run(clone, "git", "checkout", "-b", "main")
    (clone / "README.md").write_text("widgets\n")
    _run(clone, "git", "add", "README.md")
    _run(clone, "git", "commit", "-m", "first")
    _run(clone, "git", "push", "-u", "origin", "main")
    return origin, clone


class FakeGitHub:
    """The GitHub port without GitHub. Same methods as `dev_github.GitHub`; the data a test sets is `state`, `labels`,
    `check_rows`, `comment_rows` and `merge_commit` (the methods `checks` and `comments` keep their real names).
    `head_sha` follows real pushes to the scratch origin. `fail_on` names calls that raise GitHubError."""

    def __init__(self, origin: Optional[Path] = None, repo: str = "josh/widgets", fail_on=()):
        self.origin = origin
        self.repo = repo
        self.fail_on = set(fail_on)
        self.calls: List[tuple] = []
        self.state = "OPEN"
        self.labels: List[str] = []
        self.check_rows: List[Check] = []
        self.comment_rows: List[PrComment] = []
        self.merge_commit = ""
        self.number = 7
        self.branch: Optional[str] = None
        self.base = "main"
        self.title = ""
        self.body = ""
        self.default_branch_name = "main"
        self.run_rows: List[dict] = []     # {"conclusion": str, "created_at": str}, newest first

    def _maybe(self, call: str) -> None:
        if call in self.fail_on:
            raise GitHubError("{} failed".format(call))

    def _head(self) -> str:
        if self.origin is None or not self.branch:
            return ""
        done = subprocess.run(["git", "--git-dir", str(self.origin), "rev-parse", "refs/heads/" + self.branch],
                              stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, universal_newlines=True)
        return done.stdout.strip() if done.returncode == 0 else ""

    def _pr(self) -> PullRequest:
        return PullRequest(self.number, "https://github.com/{}/pull/{}".format(self.repo, self.number), self.state,
                           self._head(), self.branch or "", self.base, list(self.labels), self.merge_commit)

    def pr(self, number):
        self._maybe("pr")
        self.calls.append(("pr", number))
        return self._pr()

    def open_pr_for(self, branch):
        self._maybe("open_pr_for")
        self.calls.append(("open_pr_for", branch))
        return self._pr() if self.branch == branch and self.state == "OPEN" else None

    def create_pr(self, head, base, title, body):
        self._maybe("create_pr")
        self.calls.append(("create_pr", head, base, title, body))
        self.branch, self.base, self.title, self.body, self.state = head, base, title, body, "OPEN"
        return self._pr()

    def comments(self, number):
        self._maybe("comments")
        return list(self.comment_rows)

    def comment(self, number, body):
        self._maybe("comment")
        self.calls.append(("comment", number, body))
        self.comment_rows.append(PrComment("claude", body, "2026-11-17T00:00:00Z"))

    def ensure_labels(self):
        self._maybe("ensure_labels")
        self.calls.append(("ensure_labels",))

    def add_label(self, number, label):
        self._maybe("add_label")
        self.calls.append(("add_label", number, label))
        if label not in self.labels:
            self.labels.append(label)

    def remove_label(self, number, label):
        self._maybe("remove_label")
        self.calls.append(("remove_label", number, label))
        if label in self.labels:
            self.labels.remove(label)

    def checks(self, number):
        self._maybe("checks")
        return list(self.check_rows)

    def merge_squash(self, number, head_sha):
        self._maybe("merge_squash")
        self.calls.append(("merge_squash", number, head_sha))
        if head_sha != self._head():
            raise GitHubError("the head moved since it was read")
        self.state = "MERGED"
        self.merge_commit = self.merge_commit or "0123456789abcdef0123456789abcdef01234567"

    def delete_branch(self, branch):
        self._maybe("delete_branch")
        self.calls.append(("delete_branch", branch))

    def default_branch(self):
        self._maybe("default_branch")
        self.calls.append(("default_branch",))
        return self.default_branch_name

    def workflow_runs(self, workflow, branch, since):
        self._maybe("workflow_runs")
        self.calls.append(("workflow_runs", workflow, branch, since))
        return [dict(row) for row in self.run_rows if row["created_at"] >= since][:100]


def make_dev_deps(tmp: Path, ticket=None, github=None, clone: Optional[Path] = None, merges: str = "josh", now=None,
                  environ: Optional[dict] = None, **extra):
    """Deps for a development gate: the ticket and GitHub fakes, a registry naming system `widgets` (repository
    `widgets`, the clone's folder, who merges), and a run folder under `tmp` with an empty work folder."""
    tmp = Path(tmp)
    system = {"name": "widgets", "description": "The widget ordering system", "repositories": ["widgets"],
              "merges": merges, "folders": [str(clone)] if clone else []}
    registry = tmp / "registry.json"
    registry.write_text(json.dumps({"systems": [system]}))
    runs_dir = tmp / "runs"
    work_dir = runs_dir / "run-1" / "work"
    work_dir.mkdir(parents=True, exist_ok=True)
    fake_github = github or FakeGitHub()
    env = dict(environ) if environ is not None else {"HOME": str(tmp / "home"), "PATH": os.environ.get("PATH", "")}
    clock = now or datetime(2026, 11, 17, 12, 0, 0, tzinfo=timezone.utc)
    deps = SimpleNamespace(
        ticket=ticket or FakeTicket(key=KEY), github=lambda repo: fake_github, fake_github=fake_github,
        now=lambda: clock, run_id="run-1", runs_dir=runs_dir, work_dir=work_dir, registry_path=registry,
        artifacts_root=tmp / "artifacts", environ=env, outbox_dir=tmp / "outbox",
        mailer=lambda args: 0, draft_email=lambda to, subject, path: None)
    for name, value in extra.items():
        setattr(deps, name, value)
    return deps


def fake_gh(tmp: Path, responses: Dict[str, dict]) -> Tuple[str, Path]:
    """A fake `gh` first on PATH. `responses` maps the start of the argument string (longest match wins) to
    {"rc": int, "out": str, "err": str}. Every call is appended to <tmp>/gh-calls.jsonl as {"args": [...], "stdin": str}.
    Returns (the PATH to use, the calls file)."""
    folder = Path(tmp) / "fakebin"
    folder.mkdir(parents=True, exist_ok=True)
    calls = Path(tmp) / "gh-calls.jsonl"
    table = Path(tmp) / "gh-responses.json"
    table.write_text(json.dumps(responses))
    script = folder / "gh"
    script.write_text("#!{py}\nimport json, sys\nargs = sys.argv[1:]\n"
                      "stdin = '' if sys.stdin.isatty() else sys.stdin.read()\n"
                      "open({calls!r}, 'a').write(json.dumps({{'args': args, 'stdin': stdin}}) + '\\n')\n"
                      "table = json.load(open({table!r}))\ntext = ' '.join(args)\n"
                      "best = max((k for k in table if text.startswith(k)), key=len, default=None)\n"
                      "r = table[best] if best is not None else {{'rc': 0, 'out': '', 'err': ''}}\n"
                      "sys.stdout.write(r.get('out', ''))\nsys.stderr.write(r.get('err', ''))\nsys.exit(r.get('rc', 0))\n"
                      .format(py=sys.executable, calls=str(calls), table=str(table)))
    script.chmod(0o755)
    return str(folder) + os.pathsep + os.environ.get("PATH", ""), calls


def read_calls(calls: Path) -> List[dict]:
    if not calls.exists():
        return []
    return [json.loads(line) for line in calls.read_text().splitlines() if line.strip()]
