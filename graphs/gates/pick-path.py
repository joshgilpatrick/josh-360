#!/usr/bin/env python3
"""DRAFT gate: pick-path. Designed in docs/design/non-development-graph.md (JP-104); built in JP-123.

Decides the weight of the check, with no model: short when the precedent answers the ticket or the kind is misc; full otherwise, and always full after a revision.

Outcomes: short, full.
Inputs arrive as GRAPH_INPUT_<NAME>; prints one JSON line (graphs/CONVENTION.md, "Gate scripts").
Until it is built it refuses, so no run can pass through it by accident.
"""
import sys

sys.exit("pick-path: not built yet (JP-123)")
