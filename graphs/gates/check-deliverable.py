#!/usr/bin/env python3
"""DRAFT gate: check-deliverable. Designed in docs/design/non-development-graph.md (JP-104); built in JP-123.

Checks the deliverable and the evidence file exist under Josh's artifacts folder (not inside any repository or worktree), the evidence names at least one source, every saved query file it lists exists, and the file names start with the ticket key.

Outcomes: complete, incomplete.
Inputs arrive as GRAPH_INPUT_<NAME>; prints one JSON line (graphs/CONVENTION.md, "Gate scripts").
Until it is built it refuses, so no run can pass through it by accident.
"""
import sys

sys.exit("check-deliverable: not built yet (JP-123)")
