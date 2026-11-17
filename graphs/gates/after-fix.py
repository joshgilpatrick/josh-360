#!/usr/bin/env python3
"""DRAFT gate: after-fix. Designed in docs/superpowers/specs/2026-11-17-development-graph-design.md (JP-115); built in the JP-115 build.

Runs every phase check again (report only). If any fails: checks_failed, nothing posted. Otherwise posts the fixer's resolution on the pull request, then follows docs/WORKFLOW.md section 4: N > 3, or a fix for failed checks, re-queues the audit (requeue); N <= 3 removes the other review labels and adds review:ready-for-human (relabel).

Outcomes: requeue, relabel, checks_failed.
Inputs arrive as GRAPH_INPUT_<NAME>; prints one JSON line (graphs/CONVENTION.md, "Gate scripts").
Until it is built it refuses, so no run can pass through it by accident.
"""
import sys

sys.exit("after-fix: not built yet (JP-115)")
