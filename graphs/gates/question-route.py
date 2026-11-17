#!/usr/bin/env python3
"""DRAFT gate: question-route. Designed in docs/superpowers/specs/2026-11-17-development-graph-design.md (JP-115); built in the JP-115 build.

Decides where a designer's question goes: to_triage for a build ticket (JP-103's return door), to_josh for a Research ticket, whose questions are its work.

Outcomes: to_triage, to_josh.
Inputs arrive as GRAPH_INPUT_<NAME>; prints one JSON line (graphs/CONVENTION.md, "Gate scripts").
Until it is built it refuses, so no run can pass through it by accident.
"""
import sys

sys.exit("question-route: not built yet (JP-115)")
