#!/usr/bin/env python3
"""DRAFT gate: read-ticket. Designed in docs/design/non-development-graph.md (JP-104); built in JP-123.

Reads the JP ticket: it is in JP, its Question, Sources and Deliverable format sections are filled, and its route is non-development. Outputs search_terms (from the Question and the system's registry entry) and deliverable_given (false when the ticket marks the Deliverable format as inferred). Any failure is not_here.

Outcomes: workable, not_here.
Inputs arrive as GRAPH_INPUT_<NAME>; prints one JSON line (graphs/CONVENTION.md, "Gate scripts").
Until it is built it refuses, so no run can pass through it by accident.
"""
import sys

sys.exit("read-ticket: not built yet (JP-123)")
