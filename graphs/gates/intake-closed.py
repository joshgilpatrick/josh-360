#!/usr/bin/env python3
"""Exit gate of ticket-creation.

Inputs: none are passed to an exit gate; it reads the run's own values from $JOSH360_RUNS/$JOSH360_RUN_ID/run.json.
Outcomes: pass, open.
Rule: pass when the item ended one of two ways (a drop ends the run before this gate): every proposed ticket exists,
reads back from Jira with a parent or an area, and the source item carries the first key; or the open match was
commented on and the source item carries the match's key. Anything else is open and goes back to Josh. A Jira or store
that cannot answer is open, never pass.

Built in JP-121 from the design in docs/design/ticket-creation-graph.md.
"""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib import sources  # noqa: E402
from lib.contracts import ContractError, load_proposal  # noqa: E402
from lib.gate_io import fail, finish  # noqa: E402


def run_values():
    base = Path(os.environ.get("JOSH360_RUNS") or "~/.josh-360/runs").expanduser() / os.environ.get("JOSH360_RUN_ID", "")
    doc = json.loads((base / "run.json").read_text(encoding="utf-8"))
    values = dict(doc.get("inputs") or {})
    for outputs in (doc.get("outputs") or {}).values():
        values.update(outputs)
    return values


def decide(values, jira):
    """(outcome, summary)."""
    proposal = load_proposal(values.get("proposal"))
    state = sources.item_state(values.get("source", ""), values.get("source_ref", ""))
    if not state["known"]:
        return "open", "the source item cannot be read"
    stored = values.get("source") in sources.WITH_STORE   # a session or manual source has nowhere to carry a key
    if proposal["action"] == "comment_on_match":
        want = proposal["match"]["key"]
        if stored and state["ticket_key"] != want:
            return "open", f"the source item does not carry {want}"
        return "pass", f"commented on {want}"
    keys = values.get("ticket_keys") or []
    if isinstance(keys, str):
        keys = json.loads(keys)
    if len(keys) != len(proposal["tickets"]):
        return "open", f"{len(keys)} of {len(proposal['tickets'])} tickets exist"
    for key in keys:
        issue = jira.get(key)
        if issue is None:
            return "open", f"{key} cannot be read back"
        if not (issue["parent"] or (proposal.get("route") or {}).get("area") or issue["labels"]):
            return "open", f"{key} has no parent and no area"
    if stored and state["ticket_key"] != keys[0]:
        return "open", "the source item does not carry the new key"
    return "pass", f"{len(keys)} ticket(s) exist and are linked"


if __name__ == "__main__":
    from lib.jira import Jira

    try:
        outcome, summary = decide(run_values(), Jira.from_env())
    except (OSError, ValueError, ContractError) as err:
        fail(f"intake-closed: {err}")
    finish(outcome, summary=summary)
