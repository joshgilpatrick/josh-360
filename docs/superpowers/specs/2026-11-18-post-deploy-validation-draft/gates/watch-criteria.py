#!/usr/bin/env python3
"""DRAFT for JP-164: the contract of a gate script that is not built yet.

Step watch (a wait step). Reads only; its one write is its own check log in the run's work folder.

Answers `pending` at once, from the watch file alone, until a check is due. When one is due it runs each
criterion's collector, appends one line to `<run>/work/watch/round-<n>.checks.jsonl`, and grades the log
against "Complete when" and "Give up after". It reads the ticket's status at most once an hour.
Inputs: ticket_key, watch_file.
Outcomes: met, needs_josh (every scripted criterion is met and the ticket has a criterion tagged @manual),
not_met, no_data, left_deployed (the ticket is no longer in Deployed).
Outputs: watch_result, tally.
A reading is numbers and short codes only. No text from the system that was read is kept.

Design: docs/superpowers/specs/2026-11-18-post-deploy-validation-design.md.
"""
import sys

if __name__ == "__main__":
    sys.exit("draft: watch-criteria is not built (JP-164)")
