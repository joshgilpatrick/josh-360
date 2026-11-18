"""`<run folder>/sessions/` files: one per step attempt, written only by the runner (JP-117).

The link file beside each is written only by the link hook. A session is *live* while its state is `spawning` or
`started`; an unreadable file counts as live, because unknown is not empty.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import List, Optional

from . import paths  # noqa: F401  (puts the repository root on sys.path)
from walker_lib import runfolder  # noqa: E402  (graphs/tools, put on the path by walk.py)

LIVE = ("spawning", "started")


class Unreadable(Exception):
    """The file is there and cannot be read."""


def _folder(run: str) -> Path:
    return runfolder.folder(run) / "sessions"


def path(run: str, step: str, attempt: int) -> Path:
    return _folder(run) / "{}-{}.json".format(step, attempt)


def link_path(run: str, step: str, attempt: int) -> Path:
    return _folder(run) / "{}-{}.link.json".format(step, attempt)


def _read(p: Path) -> Optional[dict]:
    if not p.is_file():
        return None
    try:
        doc = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError) as err:
        raise Unreadable("{}: {}".format(p.name, err))
    if not isinstance(doc, dict):
        raise Unreadable("{} is not an object".format(p.name))
    return doc


def read(run: str, step: str, attempt: int) -> Optional[dict]:
    return _read(path(run, step, attempt))


def read_link(run: str, step: str, attempt: int) -> Optional[dict]:
    return _read(link_path(run, step, attempt))


def write(run: str, step: str, attempt: int, doc: dict) -> None:
    target = path(run, step, attempt)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(target.name + ".tmp")
    tmp.write_text(json.dumps(doc, sort_keys=True), encoding="utf-8")
    os.replace(str(tmp), str(target))


def live(run_ids: List[str]) -> List[dict]:
    """Every session file of these runs whose state is spawning or started. An unreadable file counts as live."""
    found: List[dict] = []
    for run in run_ids:
        for p in sorted(_folder(run).glob("*.json")):
            if p.name.endswith(".link.json"):
                continue
            try:
                doc = _read(p)
            except Unreadable:
                found.append({"run": run, "state": "unreadable", "file": p.name})
                continue
            if doc is not None and doc.get("state") in LIVE:
                found.append(doc)
    return found
