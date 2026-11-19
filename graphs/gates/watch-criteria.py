#!/usr/bin/env python3
"""Wait watch-criteria (JP-167): one call of the validation watch. The graph runner calls it every five minutes.

Almost every call answers `pending` from two small files and writes nothing. When a check is due it takes a reading per
criterion, adds one line to the check log, and grades the log (lib/watch/round.py, JP-166). Its only writes are its own
notes in `<run>/work/watch/`. It never moves, flags or comments on a ticket, and never calls a model.

Outcomes: pending, met, needs_josh, not_met, no_data, left_deployed. Inputs: ticket_key, watch_file.
Outputs: watch_result, tally.
"""
from pathlib import Path

from lib.gate_run import execute, need
from lib.watch import round as watch_round


def run(inputs, deps):
    need(inputs, "ticket_key")
    outcome, outputs, summary = watch_round.step(Path(need(inputs, "watch_file")), deps)
    return outcome, outputs, summary or None


if __name__ == "__main__":
    execute(run, ["ticket_key", "watch_file"])
