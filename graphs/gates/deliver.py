#!/usr/bin/env python3
"""Gate deliver (JP-104 design, built in JP-123): hand the deliverable to Josh.

Comments on the ticket in the workflow's shape. For an emailed ask (origin email) it also replies on the email thread
through the desk mailer, which writes to Josh only. When `phi` is true, from the run or from the evidence file, the
comment and the email give paths only and never the evidence file's summary. The mailer's exit 4 (already sent) counts
as success, so a run again after a crash never sends twice; any other non-zero exit stops the run. Outputs `card`, the
comment, which the walker shows on Josh's sign-off ask.

Outcomes: delivered. Inputs: ticket_key, origin, desk_row, phi, deliverable_path, evidence_path.
"""
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from lib import evidence
from lib.gate_run import GateError, execute, need, say, screened
from lib.nondev_copy import deliver_comment, email_body
from lib.ticket_text import as_bool

MAILER_OK = (0, 4)


def send_email(key, row, body, deps):
    if not row or row == "none":
        raise GateError("origin is email but no desk row was given")
    deps.outbox_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    body_file = deps.outbox_dir / "{}-{}.md".format(re.sub(r"[^A-Za-z0-9-]", "", key), stamp)
    body_file.write_text(body, encoding="utf-8")
    code = deps.mailer(["reply", "--row", row, "--body-file", str(body_file), "--kind", "answer"])
    if code not in MAILER_OK:
        raise GateError("the desk mailer exited {}: the reply may not have been sent".format(code))


def run(inputs, deps):
    key = need(inputs, "ticket_key")
    deliverable = need(inputs, "deliverable_path")
    evidence_path = need(inputs, "evidence_path")
    try:
        doc = evidence.load(Path(evidence_path).expanduser())
    except evidence.EvidenceError as exc:
        raise GateError(str(exc))
    phi = as_bool(inputs.get("phi"), default=True) or evidence.flag(doc, "phi") is True
    summary = evidence.text_of(doc, "summary")
    comment = deliver_comment(summary, deliverable, evidence_path, phi)
    say(deps.ticket, key, comment, once=True)
    if (inputs.get("origin") or "ticket").strip() == "email":
        body = screened(email_body(key, summary, deliverable, evidence_path, phi))
        send_email(key, (inputs.get("desk_row") or "").strip(), body, deps)
    return "delivered", {"card": comment}, "delivered" + (" and emailed" if (inputs.get("origin") or "") == "email" else "")


if __name__ == "__main__":
    execute(run, ["ticket_key", "origin", "desk_row", "phi", "deliverable_path", "evidence_path"])
