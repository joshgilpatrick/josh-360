#!/usr/bin/env python3
"""A temporary job (JP-117): start the triage run of JP-116, the runner's proof ticket, once the runner has ticked.

It prints one JSON value and always exits 0 (a report is published only for a job that exits 0, and a refusal is worth
reporting): `exists` when the ledger already has a triage run for JP-116, `waiting` (with the reason) when no tick has
finished yet, there are no Jira credentials, or the walker did not admit the run, and `started` with the new run's id.
It is not `every: once`: a `once` job stops at its first exit 0, and a refusal must be tried again next hour. Removed
with the proof page. Python 3.9, standard library only. No model call.
"""
import json
import os
import sys
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from runner_lib import paths, walk, watch  # noqa: E402
from ledger import db  # noqa: E402

GRAPH, TICKET = "triage", "JP-116"


def _existing():
    conn = db.connect(db.ledger_path())
    try:
        row = conn.execute("SELECT run_id FROM graph_runs WHERE graph_id = ? AND ticket_key = ? ORDER BY id LIMIT 1",
                           (GRAPH, TICKET)).fetchone()
    finally:
        conn.close()
    return row[0] if row else None


def decide() -> dict:
    run = _existing()
    if run:
        return {"status": "exists", "run": run}
    if not (paths.state_dir() / "report.json").is_file():
        return {"status": "waiting", "why": "no tick yet"}
    if watch.jira_client(dict(os.environ)) is None:
        return {"status": "waiting", "why": "no jira credentials"}
    try:
        started = walk.call("start", "--graph", GRAPH, "--ticket", TICKET, "--runner", "agent-manager", "--input",
                            "reason=new")
    except walk.WalkerRefused as err:
        paths.log("triage_jp116_job: the walker did not admit the run: {}".format(str(err)[:200]))
        return {"status": "waiting", "why": "not admitted"}
    return {"status": "started", "run": started["run"]}


def main(out=None) -> int:
    out = out or sys.stdout
    try:
        report = decide()
    except Exception as err:  # noqa: BLE001
        paths.log("triage_jp116_job: {}: {}".format(type(err).__name__, str(err)[:200]))
        report = {"status": "error", "error": type(err).__name__}
    out.write(json.dumps(report, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
