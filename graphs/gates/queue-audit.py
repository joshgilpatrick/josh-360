#!/usr/bin/env python3
"""DRAFT gate: queue-audit. Designed in docs/superpowers/specs/2026-11-17-development-graph-design.md (JP-115); built in the JP-115 build.

Makes sure the review labels exist, adds review:needs-agent-audit, and records the round's cursor (pull request, head commit, time) in the work folder.

Outcomes: queued.
Inputs arrive as GRAPH_INPUT_<NAME>; prints one JSON line (graphs/CONVENTION.md, "Gate scripts").
Until it is built it refuses, so no run can pass through it by accident.
"""
import sys

sys.exit("queue-audit: not built yet (JP-115)")
