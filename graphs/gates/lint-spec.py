#!/usr/bin/env python3
"""DRAFT gate: lint-spec. Designed in docs/superpowers/specs/2026-11-17-development-graph-design.md (JP-115); built in the JP-115 build.

Structure only, no model. A build spec needs definition_of_done items and phases, each with an id, a non-empty task list and at least one check, and must live in the work folder, never in a worktree. A Research ticket needs a design with a Contents section, Gherkin and Out of scope, and a plan.

Outcomes: complete, incomplete.
Inputs arrive as GRAPH_INPUT_<NAME>; prints one JSON line (graphs/CONVENTION.md, "Gate scripts").
Until it is built it refuses, so no run can pass through it by accident.
"""
import sys

sys.exit("lint-spec: not built yet (JP-115)")
