#!/usr/bin/env python3
"""DRAFT gate: no-loose-ends. Shared by every graph; first added as a stub by JP-104's draft; built in JP-109.

Exit gate, shared by every graph: passes when the run leaves no loose end.

Outcomes: pass, fail.
Inputs arrive as GRAPH_INPUT_<NAME>; prints one JSON line (graphs/CONVENTION.md, "Gate scripts").
Until it is built it refuses, so no run can pass through it by accident.
"""
import sys

sys.exit("no-loose-ends: not built yet (JP-109)")
