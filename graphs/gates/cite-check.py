#!/usr/bin/env python3
"""Gate cite-check (JP-115): keep only the review defects that cite the plan.

A finding is kept when its `criterion` (`DOD-<n>`, `<phase>.task.<n>` or `<phase>.check.<n>`) resolves in the spec, its
`quote` is in that criterion's text (whitespace collapsed, case folded), its `phase` is a phase of the spec, and
`finding`, `required_fix` and `expected_evidence` are filled. Kept findings are written per phase to
feedback/<phase>.md; the phase is reopened, a filled `expected_check` is added to the phase's extra checks once, and
the review round goes up by one. Every dropped finding is appended to withdrawn.md with its reason.

Outcomes: clean, rework. Inputs: ticket_key, spec_path, work_dir, findings.
"""
import json
from pathlib import Path

from lib import dev_spec, feedback
from lib.gate_run import GateError, execute, need
from lib.ticket_text import as_list, collapse

FIELDS = ("criterion", "quote", "finding", "required_fix", "expected_evidence")


def _judge(finding, spec, phase_ids):
    """None when the finding is kept, else the reason it is dropped."""
    if not isinstance(finding, dict):
        return "a required field is empty"
    text = dev_spec.criterion_text(spec, finding.get("criterion"))
    if text is None:
        return "no such criterion"
    quote = collapse(finding.get("quote") if isinstance(finding.get("quote"), str) else "").casefold()
    if not quote or quote not in collapse(text).casefold():
        return "the quote is not in the criterion"
    if finding.get("phase") not in phase_ids:
        return "no such phase"
    if not all(isinstance(finding.get(f), str) and finding[f].strip() for f in ("finding", "required_fix", "expected_evidence")):
        return "a required field is empty"
    return None


def run(inputs, deps):
    need(inputs, "ticket_key")
    work = Path(need(inputs, "work_dir")).expanduser().resolve()
    if work != Path(deps.work_dir).expanduser().resolve():
        raise GateError("work_dir is not this run's work folder")
    try:
        findings = as_list(inputs.get("findings"))
        spec = dev_spec.load(Path(need(inputs, "spec_path")).expanduser())
        state = dev_spec.load_state(work)
    except ValueError:
        raise GateError("the findings are not a JSON list")
    except dev_spec.SpecError as exc:
        raise GateError(str(exc))
    phase_ids = [p.get("id") for p in spec.get("phases") or []]
    kept, dropped = {}, []
    for finding in findings:
        reason = _judge(finding, spec, phase_ids)
        if reason:
            dropped.append((finding, reason))
        else:
            kept.setdefault(finding["phase"], []).append(finding)
    work.mkdir(parents=True, exist_ok=True)
    if dropped:
        with open(str(work / "withdrawn.md"), "a", encoding="utf-8") as handle:
            for finding, reason in dropped:
                label = finding.get("criterion") if isinstance(finding, dict) else None
                handle.write("- {} ({})\n".format(json.dumps(str(label)), reason))
    if kept:
        folder = work / "feedback"
        folder.mkdir(parents=True, exist_ok=True)
        for pid, rows in kept.items():
            (folder / "{}.md".format(pid)).write_text(feedback.feedback_text(
                "Review defects for phase {}".format(pid),
                "Defects the plan reviewer found, each citing a criterion of the spec (contract feedback).",
                rows, FIELDS), encoding="utf-8")
            entry = state["phases"].setdefault(pid, {})
            entry["status"] = "reopened"
            extras = entry.setdefault("extra_checks", [])
            for row in rows:
                check = row.get("expected_check")
                if isinstance(check, str) and check.strip() and check.strip() not in extras:
                    extras.append(check.strip())
        state["review_round"] = int(state.get("review_round", 0)) + 1
        dev_spec.save_state(work, state)
    total = sum(len(v) for v in kept.values())
    return ("rework" if kept else "clean"), None, "{} of {} findings kept".format(total, len(findings))


if __name__ == "__main__":
    execute(run, ["ticket_key", "spec_path", "work_dir", "findings"])
