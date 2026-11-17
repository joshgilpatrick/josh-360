#!/usr/bin/env python3
"""Gate check-deliverable (JP-104 design, built in JP-123): is there a saved deliverable with a source behind it?

Complete only when the deliverable and the evidence file both exist directly inside a folder of Josh's artifacts folder
(symlinks followed, no `..`, not in a repository or a worktree), both names start with the ticket key, the evidence
names this ticket and at least one source, and every saved query it lists exists beside it. The summary says which
check failed, never what a file holds.

Outcomes: complete, incomplete. Inputs: ticket_key, phi, deliverable_path, evidence_path.
"""
from pathlib import Path

from lib import artifacts, evidence
from lib.gate_run import execute, need


def problems(inputs, deps):
    key = need(inputs, "ticket_key")
    root = deps.artifacts_root
    found = []
    for label in ("deliverable_path", "evidence_path"):
        why = artifacts.problem_with(inputs.get(label), root, key)
        if why:
            found.append("{}: {}".format(label, why))
    if found:
        return found
    deliverable = Path(inputs["deliverable_path"].strip()).expanduser().resolve()
    evidence_file = Path(inputs["evidence_path"].strip()).expanduser().resolve()
    if deliverable.parent != evidence_file.parent:
        return ["the deliverable and the evidence file are not in the same folder"]
    try:
        doc = evidence.load(evidence_file)
    except evidence.EvidenceError as exc:
        return [str(exc)]
    named = evidence.text_of(doc, "ticket")
    if named and named != key:
        found.append("the evidence file names a different ticket")
    rows = evidence.sources(doc)
    if not rows:
        found.append("the evidence file names no source")
    for row in rows:
        if row["type"] == "query":
            why = artifacts.query_file_problem(row["ref"], evidence_file.parent, key)
            if why:
                found.append(why)
    return found


def run(inputs, deps):
    found = problems(inputs, deps)
    if found:
        return "incomplete", None, "; ".join(found)[:300]
    return "complete", None, "deliverable and evidence are in place"


if __name__ == "__main__":
    execute(run, ["ticket_key", "phi", "deliverable_path", "evidence_path"])
