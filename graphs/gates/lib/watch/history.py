"""What earlier rounds of a watch found (JP-167). Reads only the watch files and check logs of one run.

A criterion is *failing* when it failed at least once and is not on a run of passes now: the same rule the verdict gate
uses to say which criteria a failed watch names. Python 3.9, standard library only.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import List, Tuple

from lib.watch import round as watch_round


def failing(tally) -> List[dict]:
    """The tally entries that failed at least once and do not end on a run of passes."""
    return [t for t in tally or [] if isinstance(t, dict) and (t.get("failed") or 0) > 0 and not t.get("streak")]


def read_plan(path: Path) -> dict:
    try:
        plan = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return plan if isinstance(plan, dict) else {}


def failed_rounds(folder: Path) -> List[Tuple[dict, List[dict]]]:
    """`(watch file, failing tally entries)` for every round of this run that ended not_met, oldest first."""
    if not folder.is_dir():
        return []
    rounds = sorted((int(m.group(1)), p) for p in folder.iterdir() for m in [watch_round.ROUND_FILE.fullmatch(p.name)]
                    if m)
    found = []
    for _, path in rounds:
        end = watch_round.ended(path)
        if end and end.get("result") == "not_met":
            found.append((read_plan(path), failing(end.get("tally"))))
    return found
