#!/usr/bin/env python3
"""DRAFT gate: close-unmerged. Designed in docs/superpowers/specs/2026-11-17-development-graph-design.md (JP-115); built in the JP-115 build.

The pull request was closed without merging: removes the worktree and the local branch when nothing unpushed is in them, comments on the ticket and moves it to Cancelled.

Outcomes: cancelled.
Inputs arrive as GRAPH_INPUT_<NAME>; prints one JSON line (graphs/CONVENTION.md, "Gate scripts").
Until it is built it refuses, so no run can pass through it by accident.
"""
import sys

sys.exit("close-unmerged: not built yet (JP-115)")
