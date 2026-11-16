#!/usr/bin/env python3
"""Writes an approved proposal to Jira, with no model.

Inputs: GRAPH_INPUT_PROPOSAL, GRAPH_INPUT_MATCH_KEY.
Outputs: ticket_keys.
Outcomes: created, commented, partial.
Rule: an open match gets one comment and nothing else. Otherwise the parent first, then each
child, each in one create (fields, labels, links, the action-triage.spec property and the
josh360.authors property), each read back. Never sets Agent Status, priority, points, assignee
or dates. An unconfirmed create is searched for, never retried blind (action-triage's rule).

Draft stub from the ticket creation design (JP-102, docs/design/ticket-creation-graph.md).
JP-121 builds it. Until then it refuses to run, so no graph can pass through it by accident.
"""
import sys

sys.exit("create-tickets: not built yet (JP-121)")
