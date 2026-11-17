#!/usr/bin/env python3
"""Gate prepare-worktree (JP-115): a worktree for the ticket, cut from a fresh origin base, and the run's work folder.

Fetches the clone, then: no branch named <KEY>-* gives a new <KEY>-<slug> (the slug is the ticket's summary) cut from
origin/<base_branch>; one is reused; more than one is a GateError naming them. A summary the patient-data screen flags
gives the slug `work`. The clone's own checkout is never touched. The work folder is the run's, outside every
repository, and is made when missing.

Outcomes: ready. Inputs: ticket_key, repo, base_branch.
"""
from lib import dev_git, patient_data
from lib.gate_run import GateError, execute, need


def run(inputs, deps):
    key = need(inputs, "ticket_key")
    repo = need(inputs, "repo")
    base = need(inputs, "base_branch")
    try:
        clone = dev_git.clone_for(deps.registry_path, repo, deps.environ)
        dev_git.git(clone, "fetch", "origin")
        existing = dev_git.ticket_branches(clone, key)
        if len(existing) > 1:
            raise GateError("{} has more than one branch: {}".format(key, ", ".join(existing)))
        if existing:
            branch = existing[0]
        else:
            summary = deps.ticket.read(key).summary
            words = "" if patient_data.scan(summary, None, False, external=True) else summary
            branch = "{}-{}".format(key, dev_git.slug(words))
        worktree = dev_git.add_worktree(clone, branch, base)
    except dev_git.GitError as exc:
        raise GateError(str(exc))
    deps.work_dir.mkdir(parents=True, exist_ok=True)
    return "ready", {"worktree": str(worktree), "branch": branch, "work_dir": str(deps.work_dir)}, \
        "worktree for {} on {}".format(key, branch)


if __name__ == "__main__":
    execute(run, ["ticket_key", "repo", "base_branch"])
