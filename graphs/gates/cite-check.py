#!/usr/bin/env python3
"""DRAFT gate: cite-check. Designed in docs/superpowers/specs/2026-11-17-development-graph-design.md (JP-115); built in the JP-115 build.

Keeps a plan-review defect only when its criterion exists in the spec (DOD-<n>, <phase>.task.<n>, <phase>.check.<n>), its quote is in that criterion's text, and finding, required_fix and expected_evidence are filled. Kept defects become feedback files and reopen their phases; dropped ones are logged in withdrawn.md and never reach a builder.

Outcomes: clean, rework.
Inputs arrive as GRAPH_INPUT_<NAME>; prints one JSON line (graphs/CONVENTION.md, "Gate scripts").
Until it is built it refuses, so no run can pass through it by accident.
"""
import sys

sys.exit("cite-check: not built yet (JP-115)")
