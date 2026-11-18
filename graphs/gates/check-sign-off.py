#!/usr/bin/env python3
"""Gate 'check-sign-off' (JP-103 design, built in JP-122): decide what the sign-off agent's verdict is worth.

Inputs: ticket_key, defects (the sign-off role's list), version (the ticket version it judged), authors.
Outcomes: ready (no defect survived), gaps (some survived), invalid.
Output: kept (the defects that name J1 to J6 and quote the ticket exactly).
invalid when the signing session is one of the ticket's authors, when the signing session is not on record (an author
is then not ruled out), or when the ticket changed while it was being judged. A dropped defect is saved with its reason
in the run folder (outputs/dropped-defects.json) and never reaches the author. The signing session comes from the
ledger's record of the sign_off step in this run, not from what the agent says about itself.
"""
import json
import os

from lib.gate_run import GateError, execute, need
from lib.ticket_text import as_list
from lib.triage import port, runs, signoff


def _save_dropped(dropped, environ):
    run_id = environ.get("JOSH360_RUN_ID")
    if not dropped or not run_id:
        return
    folder = runs.runs_dir(environ) / run_id / "outputs"
    try:
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "dropped-defects.json").write_text(json.dumps(dropped, indent=1), encoding="utf-8")
    except OSError:
        pass   # the run record is a courtesy; the verdict does not depend on it


def run(inputs, deps):
    key = need(inputs, "ticket_key")
    version = need(inputs, "version")
    try:
        defects = as_list(inputs.get("defects"))
        authors = [str(a) for a in as_list(inputs.get("authors"))]
    except ValueError:
        raise GateError("the defects or the authors are not a JSON list")
    snap = port.read_ticket(deps.jira, key, subtasks=False)
    signer = deps.signing_session(deps.environ.get("JOSH360_RUN_ID"))
    if signer is None:
        return "invalid", None, "the signing session is not on record, so it cannot be shown to differ from the authors"
    if signoff.signer_is_author(signer, authors) or signoff.signer_is_author(signer, snap.authors):
        return "invalid", None, "the signing session is one of the ticket's authors"
    if snap.version != version:
        return "invalid", None, "the ticket changed while it was being judged"
    kept, dropped = signoff.filter_defects(defects, snap.ticket.summary + "\n" + snap.ticket.description)
    _save_dropped(dropped, deps.environ)
    note = "{} kept, {} dropped ({})".format(len(kept), len(dropped), ", ".join(sorted({d["reason"] for d in dropped})) or "-")
    return ("gaps" if kept else "ready"), {"kept": kept}, note


if __name__ == "__main__":
    execute(run, ["ticket_key", "defects", "version", "authors"])
