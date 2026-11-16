#!/usr/bin/env python3
"""Writes the new ticket key back to where the intake item came from, with no model.

Inputs: GRAPH_INPUT_SOURCE, GRAPH_INPUT_SOURCE_REF, GRAPH_INPUT_TICKET_KEYS.
Outcomes: linked.
Rule: action item or to-do gets ticket:<KEY>; a desk email thread gets the key in desk.db; a
session gets a ledger link to the key and its branch.

Draft stub from the ticket creation design (JP-102, docs/design/ticket-creation-graph.md).
JP-121 builds it. Until then it refuses to run, so no graph can pass through it by accident.
"""
import sys

sys.exit("link-source: not built yet (JP-121)")
