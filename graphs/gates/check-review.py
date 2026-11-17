#!/usr/bin/env python3
"""Gate check-review (JP-104 design, built in JP-123): keep only the defects that quote the ticket.

A finding counts only when its `quote` is a line of the ticket's Question or Deliverable format, whitespace collapsed.
The kept findings are saved beside the evidence file as <KEY>-feedback.md (contract `feedback`) for the next work run to
read; when none are kept an existing feedback file is emptied, so old defects are never fixed twice.

Hardening mode (JP-115): with `work_dir` given instead of `evidence_path`, the findings are the hardener's on a
development ticket's spec. The source is the spec's text (or, for a Research ticket, the design file's text and the
plan's) plus the ticket's description, and a finding is kept when its quote is in it. Kept findings go to
hardening.md in the run's work folder; when none are kept an existing file is emptied, and every dropped finding is
appended to withdrawn.md.

Outcomes: clean, rework. Inputs: ticket_key, findings, evidence_path, spec_path, plan_path, work_dir.
"""
import json
from pathlib import Path

from lib import artifacts, dev_spec, feedback
from lib.gate_run import GateError, execute, need
from lib.ticket_text import as_list, parse_sections, quotes

FIELDS = ("quote", "where", "problem", "fix")


def feedback_text(key, kept):
    return feedback.feedback_text(
        "Feedback for {}".format(key), "Defects the reviewer found, each quoting the ticket (contract feedback).",
        kept, FIELDS)


def _file_text(raw):
    """A spec's strings when the file is a spec (one JSON object), else the file's own text; None for a missing one."""
    raw = (raw or "").strip()
    if not raw or raw == "none":
        return ""
    path = Path(raw).expanduser()
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        raise GateError("a file to check the findings against could not be read")
    try:
        doc = json.loads(text)
    except ValueError:
        return text
    return dev_spec.spec_text(doc) if isinstance(doc, dict) else text


def _harden(inputs, deps, key, findings):
    work = Path(inputs["work_dir"].strip()).expanduser().resolve()
    if work != Path(deps.work_dir).expanduser().resolve():
        raise GateError("work_dir is not this run's work folder")
    spec_given = (inputs.get("spec_path") or "").strip()
    if not spec_given or spec_given == "none":
        raise GateError("the input 'spec_path' was not given")
    source = _file_text(spec_given) + "\n" + _file_text(inputs.get("plan_path")) + "\n" + deps.ticket.read(key).description
    kept = [f for f in findings if isinstance(f, dict) and quotes(source, f.get("quote"))]
    dropped = [f for f in findings if not (isinstance(f, dict) and quotes(source, f.get("quote")))]
    work.mkdir(parents=True, exist_ok=True)
    target = work / "hardening.md"
    if kept or target.exists():
        target.write_text(feedback_text(key, kept), encoding="utf-8")
    if dropped:
        with open(str(work / "withdrawn.md"), "a", encoding="utf-8") as handle:
            for finding in dropped:
                handle.write("- {} (quotes nothing in the spec or the ticket)\n".format(
                    json.dumps(str(finding.get("quote", "")) if isinstance(finding, dict) else "")))
    return ("rework" if kept else "clean"), None, "{} of {} findings kept".format(len(kept), len(findings))


def run(inputs, deps):
    key = need(inputs, "ticket_key")
    try:
        findings = as_list(inputs.get("findings"))
    except ValueError:
        raise GateError("the findings are not a JSON list")
    if (inputs.get("work_dir") or "").strip() and not (inputs.get("evidence_path") or "").strip():
        return _harden(inputs, deps, key, findings)
    sections = parse_sections(deps.ticket.read(key).description)
    source = sections.get("Question", "") + "\n" + sections.get("Deliverable format", "")
    kept = [f for f in findings if isinstance(f, dict) and quotes(source, f.get("quote"))]
    why = artifacts.problem_with(inputs.get("evidence_path"), deps.artifacts_root, key)
    if why:
        raise GateError("evidence_path: " + why)
    target = Path(inputs["evidence_path"].strip()).expanduser().resolve().parent / (key + "-feedback.md")
    if kept or target.exists():
        target.write_text(feedback_text(key, kept), encoding="utf-8")
    summary = "{} of {} findings kept".format(len(kept), len(findings))
    return ("rework" if kept else "clean"), None, summary


if __name__ == "__main__":
    execute(run, ["ticket_key", "findings", "evidence_path", "spec_path", "plan_path", "work_dir"])
