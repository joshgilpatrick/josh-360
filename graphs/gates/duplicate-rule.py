#!/usr/bin/env python3
"""Applies Josh's duplicate rule to the Jira searcher's candidates, with no model.

Inputs: GRAPH_INPUT_CANDIDATES (a JSON list or the path to one), GRAPH_INPUT_INTAKE_RECORD.
Outputs: match_key (the open match, or the Done or Cancelled one to link; "none" when there is none), match_status.
Outcomes: open_match, new_light, new_full.
Rule: a candidate the searcher called a match whose status is not Done or Cancelled is an open match (comment on it and
stop). The first open match in the list (best first) wins over any finished one. A Done or Cancelled match gives its key
for a Relates link, and the run carries on to a new ticket. Otherwise new_light or new_full from the record's weight.
A candidate list that is not well-formed stops the run: it is not read as "no match".

Built in JP-121 from the design in docs/design/ticket-creation-graph.md.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib.contracts import ContractError, load_json, load_record  # noqa: E402
from lib.gate_io import fail, finish, read_inputs  # noqa: E402

FINISHED = ("done", "cancelled", "canceled")


def decide(candidates, weight):
    matches = [c for c in candidates if c["is_match"]]
    for c in matches:
        if c["status"].strip().casefold() not in FINISHED:
            return "open_match", c
    for c in matches:
        return "new_" + weight, c
    return "new_" + weight, None


def well_formed(candidates):
    if not isinstance(candidates, list):
        raise ValueError("candidates must be a list")
    for i, c in enumerate(candidates, start=1):
        if not (isinstance(c, dict) and isinstance(c.get("key"), str) and isinstance(c.get("status"), str)
                and isinstance(c.get("is_match"), bool)):
            raise ValueError(f"candidate {i} needs a key, a status and a true or false is_match")
    return candidates


if __name__ == "__main__":
    values = read_inputs(["candidates", "intake_record"])
    try:
        candidates = well_formed(load_json(values["candidates"]))
        weight = load_record(values["intake_record"])["weight"]
    except (ContractError, ValueError) as err:
        fail(f"duplicate-rule: {err}")
    outcome, match = decide(candidates, weight)
    finish(outcome, {"match_key": match["key"] if match else "none", "match_status": match["status"] if match else "none"},
           f"{outcome}" + (f" ({match['key']}, {match['status']})" if match else ""))
