#!/usr/bin/env python3
"""Gate clean-up (JP-115): after a merge, remove the worktree and the branches, and nothing that is at risk.

The pull request must be merged. The worktree and local branch are removed only when nothing in them is uncommitted and
the branch is at the commit the pull request holds; any refusal is a GateError with its reason and nothing is removed.
Then the remote branch is deleted (already gone is fine). Run again after it worked, it answers `cleaned`.

Outcomes: cleaned. Inputs: repo, pr_number, worktree, branch, work_dir.
"""
from pathlib import Path

from lib import dev_git
from lib.dev_github import GitHubError
from lib.gate_run import GateError, execute, need


def run(inputs, deps):
    repo, branch = need(inputs, "repo"), need(inputs, "branch")
    worktree = Path(need(inputs, "worktree")).expanduser()
    try:
        number = int(need(inputs, "pr_number"))
    except ValueError:
        raise GateError("pr_number is not a number")
    try:
        github = deps.github(repo)
        pr = github.pr(number)
        if pr.state != "MERGED":
            raise GateError("the pull request is not merged: nothing is cleaned up")
        reason = dev_git.remove_worktree(dev_git.clone_of(worktree), worktree, branch, pushed_head=pr.head_sha)
        if reason:
            raise GateError("not cleaned up, nothing was removed: {}".format(reason))
        github.delete_branch(branch)
    except (dev_git.GitError, GitHubError) as exc:
        raise GateError(str(exc))
    return "cleaned", None, "worktree and branches removed"


if __name__ == "__main__":
    execute(run, ["repo", "pr_number", "worktree", "branch", "work_dir"])
