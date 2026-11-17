#!/usr/bin/env python3
"""Gate check-review (JP-104 design, built in JP-123): keep only the defects that quote the ticket.

A finding counts only when its `quote` is a line of the ticket's Question or Deliverable format, whitespace collapsed.
The kept findings are saved beside the evidence file as <KEY>-feedback.md (contract `feedback`) for the next work run to
read; when none are kept an existing feedback file is emptied, so old defects are never fixed twice.

Outcomes: clean, rework. Inputs: ticket_key, findings, evidence_path.
"""
import json
from pathlib import Path

from lib import artifacts
from lib.gate_run import GateError, execute, need
from lib.ticket_text import as_list, parse_sections, quotes

FIELDS = ("quote", "where", "problem", "fix")


def feedback_text(key, kept):
    lines = ["# Feedback for {}".format(key), "", "Defects the reviewer found, each quoting the ticket (contract feedback).",
             "", "---"]
    if not kept:
        lines.append("[]")
    for finding in kept:
        first = True
        for field in FIELDS:
            lines.append("{}{}: {}".format("- " if first else "  ", field, json.dumps(str(finding.get(field, "")))))
            first = False
    lines.append("---")
    return "\n".join(lines) + "\n"


def run(inputs, deps):
    key = need(inputs, "ticket_key")
    try:
        findings = as_list(inputs.get("findings"))
    except ValueError:
        raise GateError("the findings are not a JSON list")
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
    execute(run, ["ticket_key", "findings", "evidence_path"])
