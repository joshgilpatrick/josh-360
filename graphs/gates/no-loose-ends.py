#!/usr/bin/env python3
"""Exit gate of the triage, development and non-development graphs (designed in JP-103, built in JP-161 on JP-109's
loose-ends finder): did the sessions that worked this run leave anything loose?

Inputs: none of the graph's; the run comes from JOSH360_RUN_ID, and the ledger from JOSH360_HOME, as for every gate.
Outcomes: pass (the run is finished), loose (the list is in `<run>/work/loose-ends.md`; the run ends as
`exit_refused`, which is Josh's to close). Anything unknown stops the run instead. The rules are in
`lib/loose_ends_gate.py`.
"""
import sqlite3

from lib.gate_run import GateError, execute


def run(inputs, deps):
    from lib import loose_ends_gate   # puts the repository on the path for `ledger` and `laptop`
    from laptop import common
    from ledger import ask, db
    from ledger.live import Live
    if not deps.run_id:
        raise GateError("the run was not named (JOSH360_RUN_ID)")
    try:
        conn = ask.open_read_only(db.ledger_path())
        try:
            return loose_ends_gate.check(conn, deps.run_id, Live(), common.now_utc(), deps.work_dir)
        finally:
            conn.close()
    except (OSError, sqlite3.Error) as exc:
        raise GateError("the ledger cannot be read, so whether anything is loose is unknown: {}".format(
            str(exc)[:120]))


if __name__ == "__main__":
    execute(run, [])
