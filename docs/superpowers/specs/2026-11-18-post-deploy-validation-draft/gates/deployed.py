#!/usr/bin/env python3
"""DRAFT for JP-164: the contract of a gate script that is not built yet.

Entry gate of the validation graph. Read-only.

Admits a ticket when its Jira status is Deployed and its Flagged field is empty.
Outcomes: pass, refused. Anything unknown (Jira cannot be read) stops the start instead.

Design: docs/superpowers/specs/2026-11-18-post-deploy-validation-design.md.
"""
import sys

if __name__ == "__main__":
    sys.exit("draft: deployed is not built (JP-164)")
