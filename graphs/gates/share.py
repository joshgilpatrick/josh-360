#!/usr/bin/env python3
"""DRAFT gate: share. Designed in docs/design/non-development-graph.md (JP-104); built in JP-123.

Runs only after Josh's accept_and_share. Shares exactly the signed-off deliverable with the one recipient the evidence file names: an email to someone other than Josh becomes an Outlook draft in Josh's mailbox for him to send; a comment goes on a named ticket outside JP. Refuses when phi is true.

Outcomes: shared, refused.
Inputs arrive as GRAPH_INPUT_<NAME>; prints one JSON line (graphs/CONVENTION.md, "Gate scripts").
Until it is built it refuses, so no run can pass through it by accident.
"""
import sys

sys.exit("share: not built yet (JP-123)")
