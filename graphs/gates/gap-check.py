#!/usr/bin/env python3
"""DRAFT gate: gap-check. Designed in docs/design/non-development-graph.md (JP-104); built in JP-123.

Fires on observable signals only, never on a model's confidence: no precedent and a Deliverable format that was inferred, not given by Josh. Outputs gap, one sentence: the restated question, the deliverable assumed, and the assumption to confirm.

Outcomes: clear, gap.
Inputs arrive as GRAPH_INPUT_<NAME>; prints one JSON line (graphs/CONVENTION.md, "Gate scripts").
Until it is built it refuses, so no run can pass through it by accident.
"""
import sys

sys.exit("gap-check: not built yet (JP-123)")
