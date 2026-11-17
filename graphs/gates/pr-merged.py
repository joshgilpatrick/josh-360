#!/usr/bin/env python3
"""Wait pr-merged (JP-115): has Josh merged (or closed) the pull request? It only reads, and has no deadline.

`merged` when GitHub says MERGED, `closed` when it says CLOSED; anything else, a failed read included, is `pending`.

Outcomes: merged, closed. Inputs: repo, pr_number.
"""
from lib.dev_github import GitHubError
from lib.gate_run import GateError, execute, need


def run(inputs, deps):
    repo = need(inputs, "repo")
    try:
        number = int(need(inputs, "pr_number"))
    except ValueError:
        raise GateError("pr_number is not a number")
    try:
        state = deps.github(repo).pr(number).state
    except GitHubError as exc:
        return "pending", None, "could not read the pull request: {}".format(str(exc)[:100])
    if state == "MERGED":
        return "merged", None, "merged"
    if state == "CLOSED":
        return "closed", None, "closed without merging"
    return "pending", None, "waiting for the merge"


if __name__ == "__main__":
    execute(run, ["repo", "pr_number"])
