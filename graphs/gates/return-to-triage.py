#!/usr/bin/env python3
"""DRAFT gate: return-to-triage. Designed in docs/design/non-development-graph.md (JP-104); built in JP-123.

Moves the ticket to Not Started, writes the reason as an open question on the ticket and sets the flag, so triage takes it again with reason rerouted. Agreed with JP-103.

Outcomes: returned.
Inputs arrive as GRAPH_INPUT_<NAME>; prints one JSON line (graphs/CONVENTION.md, "Gate scripts").
Until it is built it refuses, so no run can pass through it by accident.
"""
import sys

sys.exit("return-to-triage: not built yet (JP-123)")
