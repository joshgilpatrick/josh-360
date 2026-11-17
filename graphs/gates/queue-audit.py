#!/usr/bin/env python3
"""Gate queue-audit (JP-115): put the pull request in the laptop audit's queue.

Makes the review labels when they are missing, removes the old terminal labels (`review:changes-requested`,
`review:ready-for-human`), adds `review:needs-agent-audit` unless it is on, and writes the cursor (pull request, head,
the time) that `review-state` measures this round from. `review:audit-in-progress` and `review:audit-blocked` are never
removed: the audit clears them itself.

Outcomes: queued. Inputs: repo, pr_number, work_dir.
"""
from pathlib import Path

from lib import dev_review
from lib.dev_github import GitHubError
from lib.gate_run import GateError, execute, need


def run(inputs, deps):
    repo, work = need(inputs, "repo"), Path(need(inputs, "work_dir")).expanduser().resolve()
    if work != Path(deps.work_dir).expanduser().resolve():
        raise GateError("work_dir is not this run's work folder")
    try:
        number = int(need(inputs, "pr_number"))
    except ValueError:
        raise GateError("pr_number is not a number")
    try:
        github = deps.github(repo)
        dev_review.queue(github, number)
        head = github.pr(number).head_sha
    except GitHubError as exc:
        raise GateError(str(exc))
    cursor = dev_review.write_cursor(work, repo, number, head, dev_review.stamp(deps.now()))
    return "queued", None, "pull request {} queued for audit (round {})".format(number, cursor["round"])


if __name__ == "__main__":
    execute(run, ["repo", "pr_number", "work_dir"])
