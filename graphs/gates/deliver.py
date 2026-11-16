#!/usr/bin/env python3
"""DRAFT gate: deliver. Designed in docs/design/non-development-graph.md (JP-104); built in JP-123.

Hands the deliverable to Josh: a ticket comment with the path and, when phi is false, the summary from the evidence file; for origin email, also a reply on the email thread through the desk mailer, which only ever writes to Josh. When phi is true, the comment and the email give the path only.

Outcomes: delivered.
Inputs arrive as GRAPH_INPUT_<NAME>; prints one JSON line (graphs/CONVENTION.md, "Gate scripts").
Until it is built it refuses, so no run can pass through it by accident.
"""
import sys

sys.exit("deliver: not built yet (JP-123)")
