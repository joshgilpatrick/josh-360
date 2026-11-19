"""Why the walker refused to start a run, kept so `where` and the published report can say it (JP-172).

Python 3.9, standard library only. `watch.py` records the newest refusal for each graph and ticket in
`state/runner/refusals.json` and clears it when a run of that graph starts on the ticket. A refusal older than the
runner's `ended_runs_days` setting is dropped from what `current` returns, and from the file at the next write.

The reason is the walker's own text, cut to 200 characters (the walker says why it refused; it does not quote the
ticket). The file holds the graph, the ticket key, the reason and two times: when the refusal was first seen and when it
was last seen, because the Jira watch refuses the same ticket again on every pass until something changes.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import List, Optional

from . import paths

REASON_LIMIT = 200


def path() -> Path:
    return paths.state_dir() / "refusals.json"


def _iso(epoch: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))


def _load() -> Optional[dict]:
    """The file's entries, {} when there is no file, None when it cannot be read (unknown is not empty)."""
    try:
        doc = json.loads(path().read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        return None
    entries = doc.get("refusals") if isinstance(doc, dict) else None
    return entries if isinstance(entries, dict) else None


def _save(entries: dict) -> None:
    target = path()
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(target.name + ".tmp")
    tmp.write_text(json.dumps({"refusals": entries}, sort_keys=True, indent=1), encoding="utf-8")
    os.replace(str(tmp), str(target))


def _key(graph: str, ticket: str) -> str:
    return "{}|{}".format(graph, ticket)


def _keep_after(now: float) -> str:
    return _iso(now - float(paths.settings()["ended_runs_days"]) * 86400)


def record(graph: str, ticket: str, reason: str, now: Optional[float] = None) -> None:
    """Keep this refusal (the newest one per graph and ticket). A file that cannot be read is started again: the
    refusals are a view of the log, and losing old ones costs only what `where` can show."""
    now = time.time() if now is None else now
    try:
        entries = _load() or {}
        keep_after = _keep_after(now)
        entries = {k: v for k, v in entries.items() if isinstance(v, dict) and str(v.get("last_at")) >= keep_after}
        key = _key(graph, ticket)
        text = " ".join(str(reason).split())[:REASON_LIMIT]
        before = entries.get(key) or {}
        first = before.get("first_at") if before.get("reason") == text else None
        entries[key] = {"graph": graph, "ticket": ticket, "reason": text, "first_at": first or _iso(now),
                        "last_at": _iso(now)}
        _save(entries)
    except (OSError, ValueError):
        paths.log("refusals: could not keep the refusal of {} for {}".format(graph, ticket))


def clear(graph: str, ticket: str) -> None:
    """A run of this graph started on the ticket: its refusal no longer applies."""
    try:
        entries = _load()
        if entries and _key(graph, ticket) in entries:
            del entries[_key(graph, ticket)]
            _save(entries)
    except (OSError, ValueError):
        paths.log("refusals: could not clear the refusal of {} for {}".format(graph, ticket))


def current(now: float, ticket: Optional[str] = None) -> Optional[List[dict]]:
    """The refusals seen within `ended_runs_days`, newest first (one ticket's when `ticket` is given), or None when the
    file cannot be read."""
    entries = _load()
    if entries is None:
        return None
    keep_after = _keep_after(now)
    rows = [{k: v.get(k) for k in ("graph", "ticket", "reason", "first_at", "last_at")} for v in entries.values()
            if isinstance(v, dict) and str(v.get("last_at")) >= keep_after and (ticket is None or v.get("ticket") == ticket)]
    return sorted(rows, key=lambda r: (str(r["last_at"]), str(r["graph"])), reverse=True)
