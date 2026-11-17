#!/usr/bin/env python3
"""DRAFT gate: merge-pr. Designed in docs/superpowers/specs/2026-11-17-development-graph-design.md (JP-115); built in the JP-115 build.

Squash-merges the pull request, only when it carries review:ready-for-human and every required check on its head is green (read fresh).

Outcomes: merged.
Inputs arrive as GRAPH_INPUT_<NAME>; prints one JSON line (graphs/CONVENTION.md, "Gate scripts").
Until it is built it refuses, so no run can pass through it by accident.
"""
import sys

sys.exit("merge-pr: not built yet (JP-115)")
