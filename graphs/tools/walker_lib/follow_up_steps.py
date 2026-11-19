"""The walker's part in follow-ups (JP-175): file the new ones, notice the dropped ones, and hold a run back while a
follow-up that blocks its ticket is open. Standard library only.

A follow-up is not a step of any graph, so nothing here writes a ledger row or counts a loop. Two fixed gate scripts
do the work outside the run, as `move-ticket` does for the status: `file-follow-ups` (starts the ticket-creation run
through intake) and `follow-up-wait` (reads, never writes, whether the new ticket is Done). The walker only runs them
and reads the follow-up files (graphs/gates/lib/follow_ups.py).
"""
from __future__ import annotations

from typing import Dict, Optional

from lib import follow_ups

from . import gates, ledgerio, runfolder

FILE_GATE = "file-follow-ups"
WAIT_GATE = "follow-up-wait"
STEP = "follow-ups"          # the name `waiting` and `status` show; never a step id of a graph


def _env(run, ref: str) -> Dict[str, str]:
    env = run.env([], None)
    env["GRAPH_INPUT_FOLLOW_UP"] = ref
    return env


def file_new(run) -> None:
    """Run `file-follow-ups` once for each follow-up still `new`. A failure is a warning; the next pass tries again."""
    for doc in follow_ups.load_all(run.run_id):
        if doc.get("state") != "new":
            continue
        ref = follow_ups.ref(run.run_id, doc["id"])
        result = gates.run_gate(run.graph.root, FILE_GATE, _env(run, ref), run.cwd(), ["submitted", "refused"])
        if result.error:
            run.warnings.append("follow-up {} was not filed: {}".format(doc["id"], result.error))


def sync(run) -> None:
    """A submitted follow-up whose intake run ended with no ticket was dropped (Josh dropped it at the card, or it
    was personal work). Its key is written back by `link-source` before that run ends, so no key means none."""
    for doc in follow_ups.load_all(run.run_id):
        if doc.get("state") != "submitted" or not doc.get("intake_run"):
            continue
        try:
            intake = runfolder.load(str(doc["intake_run"]))
        except (FileNotFoundError, ValueError):
            continue
        follow_ups.settle_dropped(follow_ups.ref(run.run_id, doc["id"]), intake)


def waiting(run) -> Optional[Dict[str, object]]:
    """The `waiting` answer while a blocking follow-up is open, else None (and the old wait note is cleared)."""
    on = None
    for doc in follow_ups.load_all(run.run_id):
        if not follow_ups.blocking_open(doc):
            continue
        ref = follow_ups.ref(run.run_id, doc["id"])
        if doc.get("state") == "filed" and doc.get("key"):
            result = gates.run_gate(run.graph.root, WAIT_GATE, _env(run, ref), run.cwd(), ["pending", "resolved"])
            if result.error is None and result.outcome == "resolved":
                continue
            if result.error:
                run.warnings.append("follow-up {} could not be checked: {}".format(doc["id"], result.error))
            on = str(doc["key"])
        else:
            on = "follow-up {} (being drafted)".format(doc["id"])
        break
    before = run.doc.get("waiting") or {}
    if on is None:
        if before.get("step") == STEP:
            run.doc.pop("waiting", None)
            run.save()
        return None
    now = ledgerio.now()
    since = before.get("since") if before.get("step") == STEP else now
    run.doc["waiting"] = {"step": STEP, "on": on, "since": since, "checked": now}
    run.save()
    return {"action": "waiting", "run": run.run_id, "step": STEP, "gate": WAIT_GATE, "waiting_on": on,
            "summary": "waiting on {}".format(on), "waiting_since": since}
