"""How the runner treats a failure that started no model (JP-183). Python 3.9, standard library only.

The kinds and the sorting rule are in `laptop/failure_kinds.py`, shared with the walker and the laptop job runner. This
module adds the runner's two pieces: the stop reason it hands the walker, and the fingerprint that tells a later pass
that what the stop depended on has changed (a merge reached the laptop, `binding.json` changed, the CLI was installed),
so the run is tried again on its own with no `allow`.

It also holds the rule for a gate that stopped a run because it could not tell yet (JP-188): a gate that exits 1 says
"unknown, try later" (graphs/CONVENTION.md, "Gates"), and one that times out may clear too, so the runner retries the
gate on the same growing gaps as a spawn, at most `spawn_tries` times, before the stop is told about.
"""
from __future__ import annotations

import re
from typing import Optional

from . import notify, paths
from laptop import failure_kinds as kinds  # noqa: E402  (paths puts the repository root on sys.path)
from walker_lib import graphfile, runfolder  # noqa: E402


def fingerprint(binding, graph_id: str) -> str:
    """What a spawn depends on outside the run: the binding's settings and commands, the run's compiled graph (its
    tiers are in it) and the commit of this checkout."""
    root = paths.graphs_root() or graphfile.GRAPHS
    return kinds.fingerprint({"binding": binding.inputs(),
                              "graph": kinds.file_hash(root / "compiled" / "{}.json".format(graph_id)),
                              "commit": kinds.repo_commit(paths.ROOT)})


def stop_reason(run_id: str, code: str, kind: str, detail: str, tries: int) -> str:
    """The walker's stop reason: the kind, the code, the tool's message (already shortened and screened), the fix."""
    said = ": {}".format(detail) if detail else ""
    if kind == kinds.NEEDS_FIX:
        fix = kinds.fix_for(code)
        return ("needs a fix ({}){}. {}The run goes on by itself once the fix reaches the laptop, or resume it with "
                "runner.py resume --run {}. It used no run of the step's cap.").format(
                    code, said, "Fix: {}. ".format(fix) if fix else "", run_id)
    return ("stuck ({}) after {} tries{}. It may clear by itself; once it has, resume it with runner.py resume --run {}. "
            "It used no run of the step's cap.").format(code, tries, said, run_id)


def changed_since(stopped: Optional[dict], run_id: str, binding) -> bool:
    """True when the run was stopped by the runner for a failure that started no model, and what that failure depended
    on has changed since. A stop with no fingerprint (a walker stop: a cap, a failed gate) is never retried this way."""
    if not isinstance(stopped, dict) or not stopped.get("fingerprint"):
        return False
    try:
        graph = runfolder.load(run_id).get("graph") or ""
        return fingerprint(binding, graph) != stopped["fingerprint"]
    except Exception:  # noqa: BLE001  (unknown is not a change: the stop stands)
        return False


# A gate that exited 1 (its "could not tell yet") or timed out. A missing script, a bad outcome line or another exit code
# needs a fix, so it is never retried this way.
GATE_MAY_CLEAR = re.compile(r"^gate '[^']+' (failed \(1\)|timed out)")
GATE_RETRIES = "gate_retries"


def gate_may_clear(stopped: Optional[dict]) -> bool:
    """A walker stop at a gate that may clear by itself (not one the runner made, which has its own fingerprint)."""
    return isinstance(stopped, dict) and stopped.get("by") != "runner" and bool(
        GATE_MAY_CLEAR.match(str(stopped.get("reason") or "")))


def gate_retry(run_id: str, stopped: Optional[dict], cfg: dict, now: float) -> str:
    """What to do about a gate stop: `due` (retry it now; the try is counted), `wait` (its gap has not passed), `spent`
    (the tries ran out: tell about the stop) or `no` (not a gate stop that may clear). The count is kept in the run's
    runner.json per stopped step; a stop at another step starts a fresh count."""
    if not gate_may_clear(stopped):
        return "no"
    doc = notify.read(run_id)
    record = doc.get(GATE_RETRIES)
    if not isinstance(record, dict) or record.get("step") != stopped.get("step"):
        record = {"step": stopped.get("step"), "tries": 0, "next_at": now + kinds.gap(1, cfg["spawn_gaps_seconds"])}
        doc[GATE_RETRIES] = record
        notify.write(run_id, doc)
        return "wait"
    tries = int(record.get("tries") or 0)
    if tries >= int(cfg["spawn_tries"]):
        return "spent"
    if now < float(record.get("next_at") or 0):
        return "wait"
    record.update(tries=tries + 1, next_at=now + kinds.gap(tries + 2, cfg["spawn_gaps_seconds"]), at=now)
    notify.write(run_id, doc)
    return "due"

