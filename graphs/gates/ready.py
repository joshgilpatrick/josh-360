#!/usr/bin/env python3
"""DRAFT gate: ready. Shared by every graph; first added as a stub by JP-104's draft; built with the triage graph (JP-122).

Entry gate, owned by the triage design (JP-103): passes when the ticket is Ready and the route triage recorded names this graph.

Outcomes: pass, fail.
Inputs arrive as GRAPH_INPUT_<NAME>; prints one JSON line (graphs/CONVENTION.md, "Gate scripts").
Until it is built it refuses, so no run can pass through it by accident.
"""
import sys

sys.exit("ready: not built yet (JP-122)")
