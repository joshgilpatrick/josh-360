#!/usr/bin/env python3
"""Gate merge-pr (JP-115): squash-merge the pull request, only where agents may merge and only when it is ready.

It checks the registry again itself (`merges: agent`) and refuses any other repository. A pull request that is already
merged answers `merged` at once. Otherwise, each read fresh: the pull request is open, it carries
`review:ready-for-human` and none of the trigger, `audit-in-progress`, `changes-requested` or `audit-blocked`, and its
checks are green (at least one). Then it merges against the head commit it read, and reads the state back as merged.

Outcomes: merged. Inputs: repo, pr_number.
"""
from lib import dev_git, dev_github, dev_review
from lib.dev_github import GitHubError
from lib.gate_run import GateError, execute, need

BLOCKING = (dev_github.TRIGGER, dev_github.IN_PROGRESS, dev_github.CHANGES, dev_github.BLOCKED)


def run(inputs, deps):
    repo = need(inputs, "repo")
    if dev_git.merges_for(deps.registry_path, repo) != "agent":
        raise GateError("agents may not merge in {}: Josh merges there".format(repo))
    try:
        number = int(need(inputs, "pr_number"))
    except ValueError:
        raise GateError("pr_number is not a number")
    github = deps.github(repo)
    try:
        pr = github.pr(number)
        if pr.state == "MERGED":
            return "merged", None, "already merged"
        if pr.state != "OPEN":
            raise GateError("the pull request is {}, not open".format(pr.state.lower()))
        if dev_github.READY not in pr.labels:
            raise GateError("the pull request does not carry {}".format(dev_github.READY))
        blocking = [label for label in BLOCKING if label in pr.labels]
        if blocking:
            raise GateError("the pull request still carries {}".format(", ".join(blocking)))
        state = dev_review.check_state(github.checks(number))
        if state != "green":
            raise GateError("the checks are not green ({})".format("none reported" if state == "none" else state))
        github.merge_squash(number, pr.head_sha)
        if github.pr(number).state != "MERGED":
            raise GateError("the merge was not confirmed by GitHub")
    except GitHubError as exc:
        raise GateError(str(exc))
    return "merged", None, "pull request {} merged".format(number)


if __name__ == "__main__":
    execute(run, ["repo", "pr_number"])
