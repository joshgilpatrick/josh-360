#!/usr/bin/env python3
"""Wait fix-closed (JP-167): wait for the Bug filed for a failed watch to be closed.

Keeps one note, `<run>/work/watch/fix-<bug key>.json`, holding when it last looked. Less than an hour since: `pending`,
with no Jira read and no write. Otherwise it reads the watched ticket's status and the Bug's state and rewrites the note.
The ticket known and no longer in Deployed: `left_deployed`. The Bug Done: `shipped` (the card names the Bug and the
counts of every failed round). The Bug Cancelled or gone: `cancelled` (the card names what still fails). Anything else,
an unknown read included, is `pending`: unknown is not a reason to ask Josh. Its only writes are its own notes.

Outcomes: pending, shipped, cancelled, left_deployed. Inputs: ticket_key, bug_key. Outputs: card (the card file's path).
"""
import json
from pathlib import Path

from lib import validation_copy as copy
from lib.gate_run import execute, need
from lib.watch import history, round as watch_round, tickets, timetable

WATCHED = "Deployed"


def _looked_at(note: Path):
    try:
        return timetable.parse(json.loads(note.read_text(encoding="utf-8")).get("looked_at"))
    except (OSError, ValueError, AttributeError):
        return None


def _shipped_card(key, bug, folder):
    rounds = [copy.failed_text(plan.get("criteria") or [], failed) for plan, failed in history.failed_rounds(folder)]
    return copy.card("fix_shipped", key=key, bug_key=bug, rounds=rounds)


def _cancelled_card(key, bug, folder):
    failed = history.failed_rounds(folder)
    names = []
    if failed:
        plan, entries = failed[-1]
        by_id = {c.get("id"): c.get("name") or c.get("id") for c in plan.get("criteria") or []}
        names = [by_id.get(e.get("id"), e.get("id")) for e in entries]
    return copy.card("fix_cancelled", key=key, bug_key=bug, names=names)


def run(inputs, deps):
    key, bug = need(inputs, "ticket_key"), need(inputs, "bug_key")
    folder = Path(deps.work_dir) / "watch"
    note = folder / "fix-{}.json".format(bug)
    now = deps.now()
    looked = _looked_at(note)
    if looked is not None and (now - looked).total_seconds() < timetable.LOOK_SECONDS:
        return "pending", None, None
    status = tickets.status(deps.jira, key)
    state = tickets.state(deps.jira, bug)
    folder.mkdir(parents=True, exist_ok=True)
    note.write_text(json.dumps({"looked_at": timetable.iso(now)}) + "\n", encoding="utf-8")
    if status is not None and status != WATCHED:
        return "left_deployed", None, "{} left Deployed".format(key)
    if state == "done":
        return "shipped", {"card": copy.write_card(deps.work_dir, _shipped_card(key, bug, folder))}, \
            "{} shipped".format(bug)
    if state in ("cancelled", "missing"):
        return "cancelled", {"card": copy.write_card(deps.work_dir, _cancelled_card(key, bug, folder))}, \
            "{} was cancelled".format(bug)
    return "pending", None, None


if __name__ == "__main__":
    execute(run, ["ticket_key", "bug_key"])
