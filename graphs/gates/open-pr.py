#!/usr/bin/env python3
"""Gate open-pr (JP-115): push the branch, open the pull request, and say so on the ticket.

The title gets `<KEY>: ` in front when it lacks it. The title and the body pass the patient-data screen whatever `phi`
says. Refused (GateError): the branch is the base branch, the worktree has an uncommitted file, or the branch is not
ahead of origin/<base>. An open pull request for the branch is reused. The ticket comment is the `open_pr` copy; the
counts come from the evidence file in the work folder (0/0 when there is none, as for a Research ticket).

Outcomes: opened. Inputs: ticket_key, phi, repo, branch, worktree, work_dir, base_branch, pr_title, pr_body.
Outputs: pr_url, pr_number.
"""
from pathlib import Path

from lib import dev_copy, dev_git, evidence
from lib.dev_github import GitHubError
from lib.gate_run import GateError, execute, need, say, screened


def _counts(work_dir):
    try:
        doc = evidence.load(Path(work_dir) / "evidence.md")
        return int(doc["checks_passed"]), int(doc["checks_total"])
    except (evidence.EvidenceError, KeyError, ValueError, OSError):
        return 0, 0


def run(inputs, deps):
    key = need(inputs, "ticket_key")
    repo, branch, base = need(inputs, "repo"), need(inputs, "branch"), need(inputs, "base_branch")
    worktree = Path(need(inputs, "worktree")).expanduser()
    title, body = need(inputs, "pr_title"), need(inputs, "pr_body")
    if not title.startswith(key):
        title = "{}: {}".format(key, title)
    screened(title)
    screened(body)
    if branch == base:
        raise GateError("the branch is the base branch: nothing to open a pull request from")
    try:
        if not dev_git.is_clean(worktree):
            raise GateError("the worktree has uncommitted files: commit or remove them before the pull request")
        if dev_git.ahead_of(worktree, base) < 1:
            raise GateError("the branch has no commits beyond origin/{}".format(base))
        dev_git.push(worktree, branch)
        head = dev_git.head(worktree)
        github = deps.github(repo)
        pr = github.open_pr_for(branch) or github.create_pr(branch, base, title, body)
    except (dev_git.GitError, GitHubError) as exc:
        raise GateError(str(exc))
    passed, total = _counts(need(inputs, "work_dir"))
    say(deps.ticket, key, dev_copy.pr_opened(pr.url, passed, total, head[:7]), once=True)
    return "opened", {"pr_url": pr.url, "pr_number": str(pr.number)}, "pull request {} opened".format(pr.number)


if __name__ == "__main__":
    execute(run, ["ticket_key", "phi", "repo", "branch", "worktree", "work_dir", "base_branch", "pr_title", "pr_body"])
