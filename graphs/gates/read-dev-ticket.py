#!/usr/bin/env python3
"""DRAFT gate: read-dev-ticket. Designed in docs/superpowers/specs/2026-11-17-development-graph-design.md (JP-115); built in the JP-115 build.

Reads the ticket and its route record. build for a Story, Bug or Task routed development; design_only for a Research ticket routed development; not_here otherwise (wrong route, no registry repository, or an open question). Outputs the repository and, when resume_from names a run, the spec that run saved.

Outcomes: build, design_only, not_here.
Inputs arrive as GRAPH_INPUT_<NAME>; prints one JSON line (graphs/CONVENTION.md, "Gate scripts").
Until it is built it refuses, so no run can pass through it by accident.
"""
import sys

sys.exit("read-dev-ticket: not built yet (JP-115)")
