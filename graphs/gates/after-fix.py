#!/usr/bin/env python3
"""Gate after-fix (JP-115): check the fixer's work, push it, say so on the pull request and put it back in the queue.

A Research ticket has no checks; otherwise every check of the spec runs again, and any failure writes the feedback files
and answers `checks_failed` with nothing pushed or posted. A dirty worktree is refused (GateError). Unpushed commits are
pushed. The pull request gets the `after_fix` comment (skipped when its newest comment already says exactly that), the
resolution only when `phi` is false and the screen passes it, else it is saved to resolution.md and the comment says so.
`requeue` (another audit round) when the fix was for failed checks or more than three findings; otherwise `relabel`:
`review:changes-requested` off, `review:ready-for-human` off and on again, which starts CI. The audit's own labels
`audit-in-progress` and `audit-blocked` are never touched.

Outcomes: requeue, relabel, checks_failed. Inputs: ticket_key, ticket_type, phi, repo, pr_number, branch, spec_path,
worktree, work_dir, resolution, issue_count.
"""
from pathlib import Path

from lib import dev_checks, dev_copy, dev_git, dev_github, dev_review, dev_spec
from lib.dev_github import GitHubError
from lib.gate_run import GateError, execute, need, screened
from lib.ticket_text import as_bool, shorten

RESOLUTION_LIMIT = 700


def _resolution_text(inputs, work, phi):
    text = (inputs.get("resolution") or "").strip()
    if not text:
        raise GateError("the input 'resolution' was not given")
    if not phi:
        try:
            return screened(shorten(text, RESOLUTION_LIMIT))
        except GateError:
            pass
    path = work / "resolution.md"
    path.write_text(text, encoding="utf-8")
    return "resolution withheld: patient data, see {}".format(path)


def _count(inputs):
    try:
        return int((inputs.get("issue_count") or "").strip())
    except ValueError:
        return dev_review.UNCOUNTED


def run(inputs, deps):
    key, repo, branch = need(inputs, "ticket_key"), need(inputs, "repo"), need(inputs, "branch")
    worktree = Path(need(inputs, "worktree")).expanduser()
    work = Path(need(inputs, "work_dir")).expanduser().resolve()
    if work != Path(deps.work_dir).expanduser().resolve():
        raise GateError("work_dir is not this run's work folder")
    try:
        number = int(need(inputs, "pr_number"))
    except ValueError:
        raise GateError("pr_number is not a number")
    research = need(inputs, "ticket_type") == "Research"
    phi = as_bool(inputs.get("phi"), True)
    try:
        if not dev_git.is_clean(worktree):
            raise GateError("the worktree has uncommitted files: commit or remove them first")
        github = deps.github(repo)
        pr = github.pr(number)
        if not research:
            spec = dev_spec.load(Path(need(inputs, "spec_path")).expanduser())
            state = dev_spec.load_state(work)
            results = dev_checks.run_all(spec, state, worktree, deps.environ, dev_checks.budget(deps.environ))
            failing = dev_checks.failing_phases(results)
            for phase in spec.get("phases") or []:
                state["phases"].setdefault(phase["id"], {})["status"] = "failed" if phase["id"] in failing else "passed"
            dev_checks.write_feedback(work, results)
            dev_spec.save_state(work, state)
            if failing:
                return "checks_failed", None, "{} phase(s) still fail their checks; nothing was pushed".format(len(failing))
            dev_checks.write_evidence(work, key, pr.base_ref, worktree, results, spec)
        if dev_git.unpushed(worktree) > 0:
            dev_git.push(worktree, branch)
        count = _count(inputs)
        had_ready = dev_github.READY in github.pr(number).labels
        again = had_ready or count > 3
        text = dev_copy.fixes_pushed(0 if had_ready else count, _resolution_text(inputs, work, phi),
                                     "another audit round" if again else "ready for human")
        screened(text)
        comments = github.comments(number)
        if not comments or comments[-1].body.strip() != text.strip():
            github.comment(number, text)
        if again:
            dev_review.queue(github, number)
            outcome = "requeue"
        else:
            github.remove_label(number, dev_github.CHANGES)
            github.remove_label(number, dev_github.READY)
            github.add_label(number, dev_github.READY)
            outcome = "relabel"
        dev_review.write_cursor(work, repo, number, github.pr(number).head_sha, dev_review.stamp(deps.now()))
    except (dev_git.GitError, GitHubError, dev_spec.SpecError) as exc:
        raise GateError(str(exc))
    return outcome, None, "fixes pushed; {}".format("queued for another audit round" if outcome == "requeue"
                                                    else "set ready for human")


if __name__ == "__main__":
    execute(run, ["ticket_key", "ticket_type", "phi", "repo", "pr_number", "branch", "spec_path", "worktree",
                  "work_dir", "resolution", "issue_count"])
