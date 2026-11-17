#!/usr/bin/env python3
"""Gate verify-build (JP-115): run every check of every phase of the spec, with no model in it.

`passed` only when every check exits 0 and the worktree is clean. A failing phase gets feedback/<phase>.md in the run's
work folder (the command, the exit code or `timed out`, the end of the output); a phase that passes has its file
removed. A worktree with an uncommitted file is `failed`, with the file names in feedback/_worktree.md, and it is looked
at before the checks run so that what a check writes cannot be blamed on the builder. state.json counts each phase's
attempts and records passed or failed. evidence.md is written on every run (contract evidence).

Outcomes: passed, failed. Inputs: ticket_key, spec_path, worktree, work_dir, base_branch. Output: evidence_path.
"""
from pathlib import Path

from lib import dev_checks, dev_git, dev_spec, feedback
from lib.gate_run import GateError, execute, need


def _dirty_names(worktree):
    out = dev_git.git(worktree, "status", "--porcelain")
    return [line[3:].strip() for line in out.splitlines() if line.strip()]


def run(inputs, deps):
    key = need(inputs, "ticket_key")
    worktree = Path(need(inputs, "worktree")).expanduser()
    base = need(inputs, "base_branch")
    work = Path(need(inputs, "work_dir")).expanduser().resolve()
    if work != Path(deps.work_dir).expanduser().resolve():
        raise GateError("work_dir is not this run's work folder")
    try:
        spec = dev_spec.load(Path(need(inputs, "spec_path")).expanduser())
        state = dev_spec.load_state(work)
        dirty = _dirty_names(worktree)
        results = dev_checks.run_all(spec, state, worktree, deps.environ, dev_checks.budget(deps.environ))
        failing = dev_checks.failing_phases(results)
        for phase in spec.get("phases") or []:
            entry = state["phases"].setdefault(phase["id"], {})
            entry["attempts"] = int(entry.get("attempts", 0)) + 1
            entry["status"] = "failed" if phase["id"] in failing else "passed"
        dev_checks.write_feedback(work, results)
        marker = work / "feedback" / "_worktree.md"
        if dirty:
            marker.write_text(feedback.feedback_text(
                "Uncommitted files in the worktree", "Commit or remove these before the checks can pass.",
                [{"file": name} for name in dirty], ("file",)), encoding="utf-8")
        elif marker.exists():
            marker.unlink()
        path = dev_checks.write_evidence(work, key, base, worktree, results, spec)
        dev_spec.save_state(work, state)
    except (dev_spec.SpecError, dev_git.GitError) as exc:
        raise GateError(str(exc))
    passed = sum(1 for r in results if r.exit_code == 0)
    summary = "{}/{} checks passed{}".format(passed, len(results), "; the worktree is not clean" if dirty else "")
    ok = not failing and not dirty
    return ("passed" if ok else "failed"), {"evidence_path": str(path)}, summary


if __name__ == "__main__":
    execute(run, ["ticket_key", "spec_path", "worktree", "work_dir", "base_branch"])
