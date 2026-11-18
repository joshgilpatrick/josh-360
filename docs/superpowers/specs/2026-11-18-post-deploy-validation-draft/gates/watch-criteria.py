#!/usr/bin/env python3
"""DRAFT for JP-164: the contract of a gate script that is not built yet.

Step watch (a wait step). Reads only; its one write is its own check log in the run's work folder.

Answers `pending` at once, from the watch file alone, until the watch has begun and a check is due. When one is
due it runs each criterion's collector, appends one line to `<run>/work/watch/round-<n>.checks.jsonl`, and grades
the log against "Complete when", `fail_after` and "Give up after". It reads the ticket's status at most once an hour.
A watch whose Starts line is "after <KEY> is Done" has not begun until that ticket is read in Done (looked at in
the same hourly read); the script then writes a `began` line as the first line of the check log, and the first
check is due one "Check every" later. Before the watch begins no collector runs. It ends as no_data when that
ticket is Cancelled or does not exist, or when 90 days have passed since the round started and the watch has
not begun. A failed Jira read is unknown: keep waiting.
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
