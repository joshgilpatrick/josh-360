#!/usr/bin/env python3
"""Gate close-unmerged (JP-115): the pull request was closed without merging, so cancel the ticket.

The pull request must be closed and not merged. The worktree and local branch go only when nothing is at risk (same
rule as clean-up); a refusal keeps them and the summary says so, and the run still ends. The remote branch is never
deleted. The ticket gets the `close_unmerged` comment once, then moves to Cancelled.

Outcomes: cancelled. Inputs: ticket_key, repo, pr_url, worktree, branch, work_dir.
"""
from pathlib import Path

from lib import dev_copy, dev_git
from lib.dev_github import GitHubError, parse_pr_url
from lib.gate_run import GateError, execute, need, say


def run(inputs, deps):
    key, repo, branch = need(inputs, "ticket_key"), need(inputs, "repo"), need(inputs, "branch")
    url = need(inputs, "pr_url")
    worktree = Path(need(inputs, "worktree")).expanduser()
    try:
        url_repo, number = parse_pr_url(url)
        if url_repo.lower() != repo.lower():
            raise GateError("the pull request address is not in {}".format(repo))
        pr = deps.github(url_repo).pr(number)
        if pr.state == "MERGED":
            raise GateError("the pull request was merged, not closed")
        if pr.state != "CLOSED":
            raise GateError("the pull request is still open")
        reason = dev_git.remove_worktree(dev_git.clone_of(worktree), worktree, branch, pushed_head=pr.head_sha)
    except (dev_git.GitError, GitHubError) as exc:
        raise GateError(str(exc))
    say(deps.ticket, key, dev_copy.cancelled(url, deps.run_id), once=True)
    deps.ticket.move(key, "Cancelled")
    kept = "worktree removed" if reason is None else "worktree kept ({})".format(reason)
    return "cancelled", None, "cancelled; {}".format(kept)


if __name__ == "__main__":
    execute(run, ["ticket_key", "repo", "pr_url", "worktree", "branch", "work_dir"])
