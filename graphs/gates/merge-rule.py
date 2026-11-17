#!/usr/bin/env python3
"""DRAFT gate: merge-rule. Designed in docs/superpowers/specs/2026-11-17-development-graph-design.md (JP-115); built in the JP-115 build.

agent when the registry lets agents merge the system's repository (josh-360 only today); josh otherwise.

Outcomes: agent, josh.
Inputs arrive as GRAPH_INPUT_<NAME>; prints one JSON line (graphs/CONVENTION.md, "Gate scripts").
Until it is built it refuses, so no run can pass through it by accident.
"""
import sys

sys.exit("merge-rule: not built yet (JP-115)")
