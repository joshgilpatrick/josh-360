#!/usr/bin/env python3
"""Gate file-validation-bug (JP-167): file one linked Bug for a failed watch, or reuse the one already open.

In an order that survives a crash at any point: (1) `watch/bug.json` names a key for this round: use it; (2) else look
through the ticket's links for an open Bug labelled `validation-failure`, and use the first (a linked ticket that
cannot be read stops the run: unknown is not "no Bug"); (3) else create the Bug from the template in the ticket's own
project, and write `watch/bug.json` at once; (4) make sure the Bug is linked to the ticket (Relates); (5) post the "Not
met in production" comment and the evidence table, once. A create Jira did not confirm stops the run without a Bug and
without the comment, and the retry starts at (1).

Outcomes: filed. Inputs: ticket_key, failed, evidence. Output: bug_key. The criteria come from the newest watch file.
Everything written goes through the patient-data screen.
"""
import json
import os
from pathlib import Path

from lib import adf, validation_copy as copy
from lib.gate_run import GateError, execute, need, say, screened
from lib.jira import JiraError
from lib.ticket_text import as_list
from lib.watch import history, round as watch_round

LABEL = "validation-failure"
CLOSED = ("Done", "Cancelled")


def _linked_keys(issue):
    keys = []
    for link in issue.get("links") or []:
        for side in ("outwardIssue", "inwardIssue"):
            other = (link.get(side) or {}).get("key")
            if other and other not in keys:
                keys.append(other)
    return keys


def _open_failure_bug(jira, issue):
    for other in _linked_keys(issue):
        found = jira.get(other)
        if found is None:
            raise GateError("the linked ticket {} could not be read".format(other))
        closed = found["status"] in CLOSED or found.get("status_category") == "done"
        if found["issuetype"] == "Bug" and not closed and LABEL in found["labels"]:
            return other
    return None


def _noted(note: Path, round_no):
    try:
        found = json.loads(note.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return found.get("bug_key") if isinstance(found, dict) and found.get("round") == round_no else None


def _write_note(note: Path, round_no, bug_key):
    note.parent.mkdir(parents=True, exist_ok=True)
    tmp = note.with_name(note.name + ".tmp")
    tmp.write_text(json.dumps({"round": round_no, "bug_key": bug_key}) + "\n", encoding="utf-8")
    os.replace(str(tmp), str(note))


def _create(deps, key, issue, criteria, failed):
    system = next(iter(sorted(set(issue["labels"]) & set(deps.registry.system_names))), "")
    bug = copy.bug_ticket(key, system, criteria, failed)
    description = adf.ticket_description(bug)
    screened(bug["summary"])
    screened(adf.plain(description))
    fields = {"project": {"key": key.split("-")[0]}, "summary": bug["summary"], "issuetype": {"name": bug["type"]},
              "description": description, "labels": bug["labels"]}
    try:
        created = deps.jira.create(fields)
    except JiraError as exc:
        raise GateError("the Bug was refused: {}".format(str(exc)[:160]))
    if not created:
        raise GateError("Jira did not confirm the Bug: it may exist, so check {} before retrying".format(key))
    return created


def run(inputs, deps):
    key = need(inputs, "ticket_key")
    try:
        failed = as_list(inputs.get("failed"))
    except ValueError:
        raise GateError("the input 'failed' is not a list")
    folder = Path(deps.work_dir) / "watch"
    path = watch_round.newest(folder)
    plan = history.read_plan(path) if path else {}
    criteria, round_no = plan.get("criteria") or [], plan.get("round")
    issue = deps.jira.get(key)
    if issue is None:
        raise GateError("{} could not be read from Jira".format(key))
    bug_key = _noted(folder / "bug.json", round_no) or _open_failure_bug(deps.jira, issue)
    if bug_key is None:
        bug_key = _create(deps, key, issue, criteria, failed)
    _write_note(folder / "bug.json", round_no, bug_key)
    if not deps.jira.link("Relates", key, bug_key):
        raise GateError("the link between {} and {} was not confirmed by Jira".format(key, bug_key))
    text = copy.not_met(copy.failed_text(criteria, failed), bug_key)
    table = (inputs.get("evidence") or "").strip()
    say(deps.ticket, key, text + ("\n" + table if table else ""), once=True)
    return "filed", {"bug_key": bug_key}, "{} filed for the failed watch".format(bug_key)


if __name__ == "__main__":
    execute(run, ["ticket_key", "failed", "evidence"])
