#!/usr/bin/env python3
"""DRAFT for JP-164: the contract of a gate script that is not built yet.

Step start_watch. Writes to Josh's ticket (one comment) and to the run's work folder.

Writes this round's watch file, `<run>/work/watch/round-<n>.json`: the parsed section, its hash, the time the
round started, the time the watch begins and the time the first check is due. Posts the start comment on the
ticket (spec, "Exact copy").
The watch begins at max(round start, the moment the Starts line names): the round start for "at Deployed", the
start of the day by the laptop's clock for "on <date>". For "after <KEY> is Done" both times are left empty and
the watch script fills them in. The first check is due one "Check every" after the watch begins, and "Give up
after" is counted from the same moment.
Inputs: ticket_key, criteria, starts, check_every_hours, complete_when, give_up_days, fail_after, section_version.
Outcomes: started. Outputs: watch_file.

Design: docs/superpowers/specs/2026-11-18-post-deploy-validation-design.md.
"""
import sys

if __name__ == "__main__":
    sys.exit("draft: start-watch is not built (JP-164)")
