#!/usr/bin/env python3
"""Writes the new ticket key back to where the intake item came from, with no model.

Inputs: GRAPH_INPUT_SOURCE, GRAPH_INPUT_SOURCE_REF, GRAPH_INPUT_TICKET_KEYS, GRAPH_INPUT_MATCH_KEY.
Outcomes: linked.
Rule: the first created ticket's key (or, after a comment on an open match, that match's key) is written to the item:
a to-do or action item gets it in action-items.json under action-triage's lock, a desk email thread gets it in
desk.db's threads row, a session or a hand-typed request is recorded in the run's own outputs and the ledger. Writing
the same key again changes nothing. A write that does not read back stops the run, so the exit gate never has to guess.

Built in JP-121 from the design in docs/design/ticket-creation-graph.md.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib import sources  # noqa: E402
from lib.contracts import load_json  # noqa: E402
from lib.gate_io import fail, finish, read_inputs  # noqa: E402


def key_to_link(ticket_keys, match_key):
    if ticket_keys:
        return ticket_keys[0]
    return match_key if match_key and match_key != "none" else None


if __name__ == "__main__":
    values = read_inputs(["source", "source_ref", "ticket_keys", "match_key"])
    try:
        keys = load_json(values["ticket_keys"]) if values["ticket_keys"] else []
    except Exception as err:  # not JSON: the value is a malformed list
        fail(f"link-source: ticket_keys is not a list ({err})")
    key = key_to_link(keys, values["match_key"])
    if key is None:
        fail("link-source: there is no ticket key to link")
    if not sources.link(values["source"] or "", values["source_ref"] or "", [key]):
        fail("link-source: the key could not be written to the source item")
    finish("linked", summary=f"linked {key}")
