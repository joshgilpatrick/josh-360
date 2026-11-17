#!/usr/bin/env python3
"""Gate lint-spec (JP-115): the shape of a spec, with no model in it.

A build ticket's spec is one JSON object (YAML's JSON form) saved in the run's work folder: definition_of_done items,
phases that each have an id, a task list, checks and files, and a row for every scenario of the ticket. A Research
ticket's design and plan are files in the worktree: the design needs a Contents section, a gherkin block with a
scenario and an Out of scope section.

The work folder must be the run's own, outside the worktree and the clone (rule 5): a gate input that breaks that is a
GateError. A spec that is elsewhere, missing or unreadable is `incomplete` like any other problem, so the designer can
put it right. `incomplete` writes the problems to work/lint.md for the designer's next run and says only how many in the
summary; `complete` removes that file.

Outcomes: complete, incomplete. Inputs: ticket_key, ticket_type, spec_path, plan_path, worktree, work_dir.
"""
import re
from pathlib import Path

from lib import dev_git, dev_spec
from lib.gate_run import GateError, execute, need

CONTENTS = re.compile(r"^#{1,6}\s*Contents\s*$", re.MULTILINE)
GHERKIN = re.compile(r"^```gherkin\s*$(.*?)^```", re.MULTILINE | re.DOTALL)
OUT_OF_SCOPE = re.compile(r"^#{1,6}\s.*Out of scope", re.MULTILINE | re.IGNORECASE)


def _resolved(path):
    return Path(path).expanduser().resolve()


def _inside(child: Path, parent: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def _check_work_folder(work: Path, worktree: Path, deps) -> None:
    if work != _resolved(deps.work_dir):
        raise GateError("work_dir is not this run's work folder")
    if ".claude/worktrees" in work.as_posix():
        raise GateError("the work folder is inside a worktree folder")
    if _inside(work, worktree):
        raise GateError("the work folder is inside the worktree")
    try:
        clone = _resolved(dev_git.clone_of(worktree))
    except dev_git.GitError as exc:
        raise GateError(str(exc))
    if _inside(work, clone):
        raise GateError("the work folder is inside the repository")


def _build_problems(inputs, work: Path, deps) -> list:
    spec_file = _resolved(need(inputs, "spec_path"))
    if not _inside(spec_file, work):
        return ["the spec is not in the run's work folder, so it would not outlive the worktree"]
    try:
        spec = dev_spec.load(spec_file)
    except dev_spec.SpecError as exc:
        return [str(exc)]
    names = dev_spec.scenario_names(deps.ticket.read(need(inputs, "ticket_key")).description)
    return dev_spec.problems(spec, names)


def _research_problems(inputs, worktree: Path) -> list:
    out = []
    design = None
    for label, name in (("design", "spec_path"), ("plan", "plan_path")):
        raw = (inputs.get(name) or "").strip()
        path = _resolved(raw) if raw and raw != "none" else None
        if path is None or not path.is_file() or not _inside(path, worktree):
            out.append("the {} is not a file inside the worktree".format(label))
        elif label == "design":
            design = path
    if design is not None:
        text = design.read_text(encoding="utf-8", errors="replace")
        if not CONTENTS.search(text):
            out.append("the design has no Contents section")
        if not any("Scenario" in block for block in GHERKIN.findall(text)):
            out.append("the design has no gherkin block with a scenario")
        if not OUT_OF_SCOPE.search(text):
            out.append("the design has no Out of scope section")
    return out


def run(inputs, deps):
    need(inputs, "ticket_key")
    research = need(inputs, "ticket_type") == "Research"
    work, worktree = _resolved(need(inputs, "work_dir")), _resolved(need(inputs, "worktree"))
    _check_work_folder(work, worktree, deps)
    found = _research_problems(inputs, worktree) if research else _build_problems(inputs, work, deps)
    notes = work / "lint.md"
    if found:
        work.mkdir(parents=True, exist_ok=True)
        notes.write_text("\n".join(found) + "\n", encoding="utf-8")
        return "incomplete", None, "{} problem(s); the list is in lint.md in the work folder".format(len(found))
    if notes.exists():
        notes.unlink()
    return "complete", None, "the spec is complete"


if __name__ == "__main__":
    execute(run, ["ticket_key", "ticket_type", "spec_path", "plan_path", "worktree", "work_dir"])
