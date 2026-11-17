#!/usr/bin/env python3
"""DRAFT gate: pr-merged. Designed in docs/superpowers/specs/2026-11-17-development-graph-design.md (JP-115); built in the JP-115 build.

A wait. pending while the pull request is open; merged or closed when it is not.

Outcomes: merged, closed (pending while waiting).
Inputs arrive as GRAPH_INPUT_<NAME>; prints one JSON line (graphs/CONVENTION.md, "Gate scripts").
Until it is built it refuses, so no run can pass through it by accident.
"""
import sys

sys.exit("pr-merged: not built yet (JP-115)")
