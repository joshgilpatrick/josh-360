#!/usr/bin/env python3
"""The laptop-status branch (JP-105): what is installed on the laptop, readable from the cloud.

    python3 laptop/status.py show     print the laptop's last status (run from any clone)

The laptop pushes one small commit to `laptop-status` after each install. Its tree holds only
`status.json` (commit, time, result, short reason, counts) and, for jobs marked `report: true`,
`reports/<job>.json`. It never holds file contents.

The commit is built with git plumbing in a throwaway index, so the laptop's working copy is never
touched. It uses a fixed author, no signing and no hooks, so Josh's own git settings cannot break it.
A push is skipped unless the installed commit, main or the result changed, or the last push is a day old.
"""
from __future__ import annotations

import datetime
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Dict, Optional

sys.dont_write_bytecode = True  # keep the laptop's copy clean
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import REPO_ROOT, STATUS_BRANCH, Unexpected, dump_json, git  # noqa: E402

SCHEMA = 1
HEARTBEAT_SECONDS = 24 * 3600
LOCAL_REF = "refs/josh360/" + STATUS_BRANCH
IDENTITY = {
    "GIT_AUTHOR_NAME": "Josh 360 laptop", "GIT_AUTHOR_EMAIL": "laptop@josh-360.invalid",
    "GIT_COMMITTER_NAME": "Josh 360 laptop", "GIT_COMMITTER_EMAIL": "laptop@josh-360.invalid",
}


def make_status(commit: str, main: str, result: str, reason: str, counts: Dict[str, int], time: str) -> dict:
    return {
        "schema": SCHEMA, "commit": commit, "main": main, "time": time, "result": result,
        "reason": reason[:200],
        "counts": {k: int(counts.get(k, 0)) for k in ("changed", "unchanged", "problems")},
    }


def fetch_parent(repo: Path) -> Optional[str]:
    """The current tip of laptop-status on GitHub, or None when the branch does not exist yet."""
    listing = git(["ls-remote", "--heads", "origin", STATUS_BRANCH], repo)
    if not listing.stdout.strip():
        return None
    git(["fetch", "--quiet", "origin", "+refs/heads/{}:{}".format(STATUS_BRANCH, LOCAL_REF)], repo)
    return git(["rev-parse", LOCAL_REF], repo).stdout.strip()


def _parse_time(text: str) -> datetime.datetime:
    return datetime.datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)


def worth_pushing(previous: Optional[dict], status: dict) -> bool:
    if previous is None:
        return True
    # Only what is installed, what main was and the result count. A repeat run of the same install
    # reports changed: 0 and "already up to date"; the first run's counts and reason are worth keeping.
    strip = lambda s: {k: s.get(k) for k in ("schema", "commit", "main", "result")}  # noqa: E731
    if strip(previous) != strip(status):
        return True
    try:
        age = _parse_time(status["time"]) - _parse_time(previous["time"])
    except (KeyError, ValueError):
        return True
    return age.total_seconds() >= HEARTBEAT_SECONDS


def publish(status: Optional[dict], reports: Optional[Dict[str, object]] = None, repo: Path = REPO_ROOT) -> str:
    """Push the status and any reports. Returns "pushed" or "skipped".

    status None keeps the status already on the branch (used when a job only adds a report).
    """
    reports = reports or {}
    parent = fetch_parent(repo)
    previous = None
    if parent:
        shown = git(["show", "{}:status.json".format(parent)], repo, check=False)
        if shown.returncode == 0:
            try:
                previous = json.loads(shown.stdout)
            except ValueError:
                previous = None
    if not reports and (status is None or not worth_pushing(previous, status)):
        return "skipped"

    files = {"status.json": dump_json(status)} if status is not None else {}
    for name, data in reports.items():
        files["reports/{}.json".format(name)] = dump_json(data)

    fd, index = tempfile.mkstemp(prefix="josh360-index-")
    os.close(fd)
    os.unlink(index)
    env = dict(IDENTITY, GIT_INDEX_FILE=index)
    try:
        git(["read-tree", parent] if parent else ["read-tree", "--empty"], repo, env=env)
        for path, text in files.items():
            blob = git(["hash-object", "-w", "--stdin"], repo, input_text=text).stdout.strip()
            git(["update-index", "--add", "--cacheinfo", "100644,{},{}".format(blob, path)], repo, env=env)
        tree = git(["write-tree"], repo, env=env).stdout.strip()
    finally:
        if os.path.exists(index):
            os.unlink(index)

    if status is not None:
        message = "{} {} at {}".format(status["result"], status["commit"][:12] or "-", status["time"])
    else:
        message = "report {}".format(", ".join(sorted(reports)))
    args = ["commit-tree", "--no-gpg-sign", tree, "-m", message]
    if parent:
        args += ["-p", parent]
    commit = git(args, repo, env=IDENTITY).stdout.strip()
    git(["push", "--quiet", "origin", "{}:refs/heads/{}".format(commit, STATUS_BRANCH)], repo)
    return "pushed"


def show(repo: Path) -> int:
    try:
        parent = fetch_parent(repo)
    except Unexpected as e:
        print(e, file=sys.stderr)
        return 1
    if not parent:
        print("The laptop has not reported yet: there is no {} branch.".format(STATUS_BRANCH))
        return 1
    print(git(["show", "{}:status.json".format(parent)], repo).stdout, end="")
    reports = git(["ls-tree", "--name-only", "{}:reports".format(parent)], repo, check=False)
    if reports.returncode == 0 and reports.stdout.strip():
        print("reports: " + ", ".join(reports.stdout.split()))
    return 0


if __name__ == "__main__":
    if sys.argv[1:] == ["show"]:
        sys.exit(show(Path.cwd()))
    print(__doc__.strip().splitlines()[2].strip())
    sys.exit(2)
