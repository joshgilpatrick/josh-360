#!/usr/bin/env python3
"""DRAFT gate: review-state. Designed in docs/superpowers/specs/2026-11-17-development-graph-design.md (JP-115); built in the JP-115 build.

A wait. Reads the pull request's review labels and checks against the round's cursor: pending while the audit is queued or running, or while checks run after ready-for-human; then ready, changes (the verdict comment and N), checks_failed, blocked (review:audit-blocked) or stale (no verdict 48 hours after queueing).

Outcomes: ready, changes, checks_failed, blocked, stale (pending while waiting).
Inputs arrive as GRAPH_INPUT_<NAME>; prints one JSON line (graphs/CONVENTION.md, "Gate scripts").
Until it is built it refuses, so no run can pass through it by accident.
"""
import sys

sys.exit("review-state: not built yet (JP-115)")
