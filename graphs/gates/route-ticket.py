#!/usr/bin/env python3
"""Routes a ticket to a space and a parent with the registry's written rules, with no model.

Inputs: GRAPH_INPUT_NAMED_SPACE, GRAPH_INPUT_NAMED_PARENT, GRAPH_INPUT_INTAKE_RECORD.
Outputs: space, parent, area, priority, system, labels.
Outcomes: matched, unmatched, personal.
Rule: conventions/tickets.md, 'Routing a ticket to a space and a parent', through
scripts/conventions.py lookup. A key or space Josh named wins; then the repository, then the
folder. No match: space JP, no parent, outcome unmatched. A linear system: outcome personal.

Draft stub from the ticket creation design (JP-102, docs/design/ticket-creation-graph.md).
JP-121 builds it. Until then it refuses to run, so no graph can pass through it by accident.
"""
import sys

sys.exit("route-ticket: not built yet (JP-121)")
