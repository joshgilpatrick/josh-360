#!/usr/bin/env python3
"""Applies Josh's duplicate rule to the Jira searcher's candidates, with no model.

Inputs: GRAPH_INPUT_CANDIDATES, GRAPH_INPUT_INTAKE_RECORD.
Outputs: match_key (the open match, or the Done or Cancelled one to link), match_status.
Outcomes: open_match, new_light, new_full.
Rule: a candidate the searcher called a match whose status is not Done or Cancelled is an open
match (comment on it and stop). A Done or Cancelled match gives relates_to, and the run carries
on to create a new ticket linked to it. Otherwise new_light or new_full from the record's weight.

Draft stub from the ticket creation design (JP-102, docs/design/ticket-creation-graph.md).
JP-121 builds it. Until then it refuses to run, so no graph can pass through it by accident.
"""
import sys

sys.exit("duplicate-rule: not built yet (JP-121)")
