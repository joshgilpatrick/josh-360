#!/usr/bin/env python3
"""DRAFT gate: verify-build. Designed in docs/superpowers/specs/2026-11-17-development-graph-design.md (JP-115); built in the JP-115 build.

Runs every phase check (plus checks a review added) on the worktree's final tree, writes the evidence file (results, files changed against the base, added lines that look like placeholders) and a feedback file for each failing phase.

Outcomes: passed, failed.
Inputs arrive as GRAPH_INPUT_<NAME>; prints one JSON line (graphs/CONVENTION.md, "Gate scripts").
Until it is built it refuses, so no run can pass through it by accident.
"""
import sys

sys.exit("verify-build: not built yet (JP-115)")
