#!/usr/bin/env python3
"""DRAFT gate: clean-up. Designed in docs/superpowers/specs/2026-11-17-development-graph-design.md (JP-115); built in the JP-115 build.

After a merge: confirms the pull request is merged and nothing in the worktree is uncommitted or unpushed, then removes the worktree and the local branch (and the remote branch if GitHub kept it). Refuses rather than delete anything at risk.

Outcomes: cleaned.
Inputs arrive as GRAPH_INPUT_<NAME>; prints one JSON line (graphs/CONVENTION.md, "Gate scripts").
Until it is built it refuses, so no run can pass through it by accident.
"""
import sys

sys.exit("clean-up: not built yet (JP-115)")
