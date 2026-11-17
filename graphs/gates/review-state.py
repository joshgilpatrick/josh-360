#!/usr/bin/env python3
"""Wait review-state (JP-115): what the laptop's audit has done with the pull request. It only reads.

Answers `pending` (with the reason) until the review can go on; any failed read, or a missing cursor, is `pending`, never
"nothing there". Otherwise: merged is `ready`, closed is `blocked`; the trigger or `audit-in-progress` label is
`pending`; `audit-blocked` is `blocked`; `changes-requested` with this round's marked verdict from an audit bot is
`changes` (with the verdict as `findings` and the count N as `issue_count`, 4 when it cannot be counted); with
`ready-for-human` the checks decide (`checks_failed`, `ready`, `pending`, and with no checks `ready` once the grace has
passed). A `pending` older than 48 hours since the round was queued is `stale`.

Outcomes: ready, changes, checks_failed, blocked, stale. Inputs: repo, pr_number, work_dir.
Outputs: findings, issue_count.
"""
from datetime import timedelta
from pathlib import Path

from lib import dev_github, dev_review
from lib.dev_github import GitHubError
from lib.gate_run import GateError, execute, need


def _answer(deps, repo, number, work):
    """(outcome, outputs, summary), with `pending` for anything not settled."""
    cursor = dev_review.read_cursor(work)
    pr = deps.github(repo).pr(number)
    if pr.state == "MERGED":
        return "ready", None, "the pull request is merged"
    if pr.state == "CLOSED":
        return "blocked", None, "the pull request was closed without merging"
    if cursor is None:
        return "pending", None, "no cursor: the audit was not queued from this run"
    labels, github = set(pr.labels), deps.github(repo)
    if dev_github.TRIGGER in labels:
        return "pending", None, "waiting for the audit to pick the pull request up"
    if dev_github.BLOCKED in labels:
        return "blocked", None, "the audit needs a person"
    if dev_github.IN_PROGRESS in labels:
        return "pending", None, "the audit is running"
    if dev_github.CHANGES in labels:
        found = dev_review.verdict(github.comments(number), cursor["queued_at"], dev_review.audit_bots(deps.environ))
        if found is None:
            return "pending", None, "changes were requested but this round's verdict is not on the pull request yet"
        count = dev_review.count_findings(found.body)
        n = dev_review.UNCOUNTED if count is None else count
        return "changes", {"findings": found.body, "issue_count": n}, "{} finding(s) to fix".format(n)
    if dev_github.READY in labels:
        checks = github.checks(number)
        state = dev_review.check_state(checks)
        if state == "failed":
            return "checks_failed", {"findings": ", ".join(dev_review.failing_names(checks)), "issue_count": 0}, \
                "checks failed"
        if state == "green":
            return "ready", None, "the audit is done and the checks are green"
        if state == "pending":
            return "pending", None, "the checks are still running"
        latest = dev_review.parse_time(cursor["queued_at"])
        found = dev_review.verdict(github.comments(number), cursor["queued_at"], dev_review.audit_bots(deps.environ))
        if found is not None:
            latest = max(latest, dev_review.parse_time(found.created)) if latest else dev_review.parse_time(found.created)
        grace = timedelta(minutes=dev_review.checks_grace(deps.environ))
        if latest is not None and deps.now() - latest >= grace:
            return "ready", None, "the audit is done and no checks were reported within the grace period"
        return "pending", None, "no checks reported yet"
    return "pending", None, "no review label on the pull request yet"


def run(inputs, deps):
    repo, work = need(inputs, "repo"), Path(need(inputs, "work_dir")).expanduser().resolve()
    if work != Path(deps.work_dir).expanduser().resolve():
        raise GateError("work_dir is not this run's work folder")
    try:
        number = int(need(inputs, "pr_number"))
    except ValueError:
        raise GateError("pr_number is not a number")
    try:
        outcome, outputs, summary = _answer(deps, repo, number, work)
    except GitHubError as exc:
        outcome, outputs, summary = "pending", None, "could not read the pull request: {}".format(str(exc)[:100])
    if outcome == "pending":
        cursor = dev_review.read_cursor(work)
        queued = dev_review.parse_time((cursor or {}).get("queued_at"))
        if queued is not None and deps.now() - queued > timedelta(hours=dev_review.STALE_HOURS):
            return "stale", None, "no answer from the audit in {} hours".format(dev_review.STALE_HOURS)
    return outcome, outputs, summary


if __name__ == "__main__":
    execute(run, ["repo", "pr_number", "work_dir"])
