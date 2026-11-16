#!/usr/bin/env python3
"""Completeness check on a ticket proposal, with no model.

Inputs: GRAPH_INPUT_PROPOSAL.
Outcomes: pass, fixable, needs_josh.
Rule: every ticket passes the per-type Ready checklist owned by the triage graph (JP-103,
ready-check), plus three creation checks: a parent epic or a registry area, no unclear type or
work kind, and the patient-data scan. A missing section the drafter can write is fixable; an
entry in the proposal's Gaps list, an unclear type, or no parent and no area is needs_josh.

Draft stub from the ticket creation design (JP-102, docs/design/ticket-creation-graph.md).
JP-121 builds it. Until then it refuses to run, so no graph can pass through it by accident.
"""
import sys

sys.exit("ticket-complete: not built yet (JP-121)")
