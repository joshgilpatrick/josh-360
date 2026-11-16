#!/usr/bin/env python3
"""DRAFT gate: close-ticket. Designed in docs/design/non-development-graph.md (JP-104); built in JP-123.

Posts the resolution comment in its fixed shape (question, answer summary, sources, deliverable path; path only when phi is true) and moves the ticket to Done.

Outcomes: closed.
Inputs arrive as GRAPH_INPUT_<NAME>; prints one JSON line (graphs/CONVENTION.md, "Gate scripts").
Until it is built it refuses, so no run can pass through it by accident.
"""
import sys

sys.exit("close-ticket: not built yet (JP-123)")
