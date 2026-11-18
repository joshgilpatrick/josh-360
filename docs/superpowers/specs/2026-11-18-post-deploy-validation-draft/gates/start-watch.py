#!/usr/bin/env python3
"""DRAFT for JP-164: the contract of a gate script that is not built yet.

Step start_watch. Writes to Josh's ticket (one comment) and to the run's work folder.

Writes this round's watch file, `<run>/work/watch/round-<n>.json`: the parsed section, its hash, the time the
round started and the time the first check is due. Posts the start comment on the ticket (spec, "Exact copy").
Inputs: ticket_key, criteria, starts, check_every_hours, complete_when, give_up_days, section_version.
Outcomes: started. Outputs: watch_file.

Design: docs/superpowers/specs/2026-11-18-post-deploy-validation-design.md.
"""
import sys

if __name__ == "__main__":
    sys.exit("draft: start-watch is not built (JP-164)")
