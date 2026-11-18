#!/usr/bin/env python3
"""DRAFT for JP-164: the contract of a gate script that is not built yet.

Step verdict. Read-only, no model.

Adds up the section and the watch into one answer:
  not_needed  the section says no, or there is none
  met         the watch ended met
  not_met     the watch ended not met
  undecided   the section cannot be read, the watch ended with no data, or every scripted criterion is met
              and a criterion tagged @manual is left for Josh
Inputs: ticket_key, needed, problems, criteria, watch_result, tally.
Outputs: result, evidence (the table for the closing comment), failed, card.

Design: docs/superpowers/specs/2026-11-18-post-deploy-validation-design.md.
"""
import sys

if __name__ == "__main__":
    sys.exit("draft: validation-verdict is not built (JP-164)")
