#!/usr/bin/env python3
"""DRAFT gate: sign-off-rule. Designed in docs/design/non-development-graph.md (JP-104); built in JP-123.

Decides, with no model, whether the run waits for Josh's sign-off: emailed when origin is email (the
answer is already in his inbox and the ticket closes; his reply to the email reopens it), ask_josh otherwise.
Josh's decision, 16 November 2026.

Outcomes: ask_josh, emailed.
Inputs arrive as GRAPH_INPUT_<NAME>; prints one JSON line (graphs/CONVENTION.md, "Gate scripts").
Until it is built it refuses, so no run can pass through it by accident.
"""
import sys

sys.exit("sign-off-rule: not built yet (JP-123)")
