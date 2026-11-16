#!/usr/bin/env python3
"""DRAFT gate: move-ticket. Shared by every graph; first added as a stub by JP-104's draft; built in JP-123.

Moves the ticket to the Jira status of the step's stretch in the graph header, and reads the move back. Shared with the other graphs.

Outcomes: moved.
Inputs arrive as GRAPH_INPUT_<NAME>; prints one JSON line (graphs/CONVENTION.md, "Gate scripts").
Until it is built it refuses, so no run can pass through it by accident.
"""
import sys

sys.exit("move-ticket: not built yet (JP-123)")
