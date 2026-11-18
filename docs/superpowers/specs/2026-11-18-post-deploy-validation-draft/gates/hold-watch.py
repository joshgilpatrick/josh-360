#!/usr/bin/env python3
"""DRAFT for JP-164: the contract of a gate script that is not built yet.

Step hold. Writes to Josh's ticket: the flag and one comment.

Sets the Jira flag on the ticket and posts the hold comment (spec, "Exact copy"). The start rule skips a flagged
ticket, so nothing watches it again until the flag is cleared.
Inputs: ticket_key. Outcomes: held.

Design: docs/superpowers/specs/2026-11-18-post-deploy-validation-design.md.
"""
import sys

if __name__ == "__main__":
    sys.exit("draft: hold-watch is not built (JP-164)")
