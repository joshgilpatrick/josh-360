#!/usr/bin/env python3
"""Gate 'apply-revision' (JP-103 design, built in JP-122): write the ticket drafter's revision to an OWN ticket.

Inputs: ticket_key, proposal (action revise; graphs/contracts/ticket-proposal.md, "A revision"), version (the ticket
version the drafter was given). Outcomes: applied, changed (the ticket moved since the drafter read it: nothing written).
Rewrites the description from the proposal's sections in place, adds the drafter's sessions to josh360.authors, and
comments the round (spec, "Exact copy"). Never edits a ticket an allowed account did not create (spec rule 7). Every
write is read back; one that does not read back stops the run. The summary, type, labels and links are not touched.
"""
from lib import adf
from lib.contracts import ContractError, load_revision
from lib.gate_run import GateError, execute, need
from lib.triage import copy, port, runs
from lib.triage.ticket import parse_sections


def _changed_sections(before, after):
    old = dict(before)
    new = dict(after)
    names = [n for n, _ in after] + [n for n, _ in before if n not in new]
    return [n for n in dict.fromkeys(names) if " ".join(old.get(n, "").split()) != " ".join(new.get(n, "").split())]


def run(inputs, deps):
    key = need(inputs, "ticket_key")
    version = need(inputs, "version")
    run_id = deps.environ.get("JOSH360_RUN_ID") or "unknown"
    try:
        revision = load_revision(inputs.get("proposal"))
    except ContractError as exc:
        raise GateError("the revision is not in the contract: {}".format(exc))
    proposed = revision["tickets"][0]
    if proposed["key"] != key:
        raise GateError("the revision is for {}, not {}".format(proposed["key"], key))
    snap = port.read_ticket(deps.jira, key, subtasks=False)
    if port.author_kind(snap.ticket.creator, port.allowed_accounts(deps.jira, deps.environ)) != "own":
        raise GateError("{} is not an own ticket: triage never edits someone else's ticket".format(key))
    if proposed["type"] != snap.ticket.type:
        raise GateError("the revision changes the type: that is not a revision")
    if snap.version != version:
        return "changed", None, "the ticket changed since the drafter read it: nothing written"
    document = adf.ticket_description({"type": snap.ticket.type, "sections": proposed["sections"],
                                       "repository": proposed["repository"], "where_it_runs": proposed["where_it_runs"]})
    changed = _changed_sections(snap.ticket.sections, parse_sections(adf.to_marked(document).strip("\n")))
    if not deps.jira.set_description(key, document):
        raise GateError("the new description of {} did not read back from Jira".format(key))
    authors = list(dict.fromkeys(snap.authors + revision["authors"]))
    if authors != snap.authors and not deps.jira.set_property(key, port.AUTHORS_PROPERTY, authors):
        raise GateError("the authors of {} did not read back from Jira".format(key))
    _, comments = port.read_history(deps.jira, key)
    n = runs.prior_round_comments(comments, run_id) + 1
    if not deps.jira.comment(key, copy.round_note(n, run_id, revision["closes"], changed)):
        raise GateError("the round comment on {} was not confirmed by Jira".format(key))
    return "applied", None, "round {}: {} section(s) changed".format(n, len(changed))


if __name__ == "__main__":
    execute(run, ["ticket_key", "proposal", "version"])
