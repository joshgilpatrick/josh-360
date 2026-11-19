"""Collector `github-runs`: how a workflow's runs have gone on one branch since the watch began (JP-166).

The argument is `owner/repo workflow-file`, with an optional branch (the default branch when none is named). Only runs
that ended `success` or `failure` count; a cancelled or skipped run says nothing about the code. `last` is the newest
counted run's conclusion, unknown when there is none.
"""
from __future__ import annotations

import re

from . import reading

FIELDS = {"events": "number", "failed": "number", "last": "code"}
COUNTS_EVENTS = True
ARGUMENT = re.compile(r"^[\w.-]+/[\w.-]+ [\w.-]+\.ya?ml( [\w./-]+)?$")
COUNTED = ("success", "failure")


def read(argument: str, since: str, deps) -> dict:
    try:
        # `\w` takes letters from any alphabet, and a name made only of dots would climb out of the repository's path.
        if ARGUMENT.fullmatch(argument or "") is None or not argument.isascii():
            return reading.take(None, FIELDS)
        parts = argument.split(" ")
        repo, workflow = parts[0], parts[1]
        owner, name = repo.split("/")
        if any(part in (".", "..") for part in (owner, name, workflow)):
            return reading.take(None, FIELDS)
        github = deps.github(repo)
        branch = parts[2] if len(parts) > 2 else github.default_branch()
        runs = [run for run in github.workflow_runs(workflow, branch, since) if run.get("conclusion") in COUNTED]
        link = "https://github.com/{}/actions/workflows/{}".format(repo, workflow)
        return reading.take({"events": len(runs), "failed": sum(run["conclusion"] == "failure" for run in runs),
                             "last": runs[0]["conclusion"] if runs else None}, FIELDS, link=link)
    except Exception:   # a GitHubError, or anything else: unknown
        return reading.take(None, FIELDS)
