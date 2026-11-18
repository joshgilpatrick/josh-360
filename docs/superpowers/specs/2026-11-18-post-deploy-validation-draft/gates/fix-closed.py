#!/usr/bin/env python3
"""DRAFT for JP-164: the contract of a gate script that is not built yet.

Step await_fix (a wait step). Read-only.

Answers `pending` while the linked Bug is open. It reads Jira at most once an hour.
Inputs: ticket_key, bug_key.
Outcomes: shipped (the Bug is Done), cancelled (the Bug is Cancelled), left_deployed (the ticket is no longer in
Deployed). Outputs: card.

Design: docs/superpowers/specs/2026-11-18-post-deploy-validation-design.md.
"""
import sys

if __name__ == "__main__":
    sys.exit("draft: fix-closed is not built (JP-164)")
