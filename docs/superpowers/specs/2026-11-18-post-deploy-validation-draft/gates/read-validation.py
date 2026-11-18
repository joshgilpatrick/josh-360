#!/usr/bin/env python3
"""DRAFT for JP-164: the contract of a gate script that is not built yet.

Step read_criteria. Read-only, no model.

Reads the ticket's Validation section with the same parser the Ready checklist uses (items V1 to V7).
Inputs: ticket_key.
Outcomes: watch (the section says "Needed: yes" and every line parses), not_needed (the section says
"Needed: no", or the ticket has no Validation section), unreadable (a section is there and a line does not parse).
Outputs: needed, criteria, starts, check_every_hours, complete_when, give_up_days, section_version, problems.

Design: docs/superpowers/specs/2026-11-18-post-deploy-validation-design.md.
"""
import sys

if __name__ == "__main__":
    sys.exit("draft: read-validation is not built (JP-164)")
