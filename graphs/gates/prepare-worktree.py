#!/usr/bin/env python3
"""DRAFT gate: prepare-worktree. Designed in docs/superpowers/specs/2026-11-17-development-graph-design.md (JP-115); built in the JP-115 build.

Fetches the repository's clone, cuts <KEY>-<slug> from a fresh origin/<base_branch> (reusing the branch when it exists), adds a worktree under the clone's .claude/worktrees/, and makes the run's work folder outside it.

Outcomes: ready.
Inputs arrive as GRAPH_INPUT_<NAME>; prints one JSON line (graphs/CONVENTION.md, "Gate scripts").
Until it is built it refuses, so no run can pass through it by accident.
"""
import sys

sys.exit("prepare-worktree: not built yet (JP-115)")
