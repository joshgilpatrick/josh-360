#!/usr/bin/env python3
"""DRAFT gate: check-review. Designed in docs/design/non-development-graph.md (JP-104); built in JP-123.

Drops every finding that does not quote the ticket's Question or Deliverable format, and saves the rest as feedback. rework when any finding is left.

Outcomes: clean, rework.
Inputs arrive as GRAPH_INPUT_<NAME>; prints one JSON line (graphs/CONVENTION.md, "Gate scripts").
Until it is built it refuses, so no run can pass through it by accident.
"""
import sys

sys.exit("check-review: not built yet (JP-123)")
