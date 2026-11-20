"""How the runner treats a failure that started no model (JP-183). Python 3.9, standard library only.

The kinds and the sorting rule are in `laptop/failure_kinds.py`, shared with the walker and the laptop job runner. This
module adds the runner's two pieces: the stop reason it hands the walker, and the fingerprint that tells a later pass
that what the stop depended on has changed (a merge reached the laptop, `binding.json` changed, the CLI was installed),
so the run is tried again on its own with no `allow`.
"""
from __future__ import annotations

from typing import Optional

from . import paths
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
