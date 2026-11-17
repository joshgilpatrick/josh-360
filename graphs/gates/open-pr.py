#!/usr/bin/env python3
"""DRAFT gate: open-pr. Designed in docs/superpowers/specs/2026-11-17-development-graph-design.md (JP-115); built in the JP-115 build.

Screens the title and body for patient data, pushes the branch (never the default branch), opens the pull request or reuses the branch's open one, and comments its link on the ticket.

Outcomes: opened.
Inputs arrive as GRAPH_INPUT_<NAME>; prints one JSON line (graphs/CONVENTION.md, "Gate scripts").
Until it is built it refuses, so no run can pass through it by accident.
"""
import sys

sys.exit("open-pr: not built yet (JP-115)")
