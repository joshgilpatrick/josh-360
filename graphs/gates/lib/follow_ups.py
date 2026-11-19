"""Follow-ups: work a graph step found outside its ticket (JP-175). Python 3.9, standard library only.

A role step's result file may carry `follow_ups` beside `outcome` and `outputs` (graphs/contracts/follow-up.md). The
walker's `record` checks the list with `check` and saves each entry as one file in the run folder:

    $JOSH360_RUNS/<run id>/follow-ups/<step>-<attempt>-<n>.json

The file is the follow-up's only record of its words. Everything else refers to it by its pointer,
`follow-up:<run id>:<file id>`, which is what `graphs/intake/submit.py --source session --ref` is given, so the step's
words never travel as command text. States move one way: `new` (recorded) -> `submitted` (an intake run started) ->
`filed` (that run wrote or matched a ticket; `key` holds it) or `dropped` (it ended with no ticket); a filed one that
blocked its ticket becomes `resolved` once the new ticket is Done or Cancelled.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Dict, List, Optional, Tuple

MAX_ITEMS = 5
MAX_SUMMARY = 120
MAX_WHY = 300
LABEL = "graph-follow-up"
PREFIX = "follow-up:"
STATES = ("new", "submitted", "filed", "dropped", "resolved")
FILE_ID = re.compile(r"^[a-z0-9_]+-[1-9][0-9]*-[1-9][0-9]*$")
RUN_ID = re.compile(r"^[A-Za-z0-9_.-]{1,80}$")
KEY = re.compile(r"^[A-Z][A-Z0-9]+-[1-9][0-9]*$")
DONE_STATUSES = ("done", "cancelled", "canceled")


class Invalid(ValueError):
    """A `follow_ups` list a step wrote that does not fit the contract. The message says which entry and why."""


def runs_dir() -> Path:
    return Path(os.path.expanduser(os.environ.get("JOSH360_RUNS") or "~/.josh-360/runs"))


def check(raw: object) -> List[Dict[str, object]]:
    """The cleaned list, or Invalid. Absent or empty is an empty list."""
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise Invalid('"follow_ups" must be a list')
    if len(raw) > MAX_ITEMS:
        raise Invalid('"follow_ups" holds {} entries; at most {}'.format(len(raw), MAX_ITEMS))
    cleaned = []
    for n, item in enumerate(raw, 1):
        if not isinstance(item, dict):
            raise Invalid("follow-up {} is not an object".format(n))
        extra = sorted(set(item) - {"summary", "why", "blocks"})
        if extra:
            raise Invalid("follow-up {} has the unknown field '{}'".format(n, extra[0]))
        summary, why, blocks = item.get("summary"), item.get("why"), item.get("blocks")
        if not isinstance(summary, str) or not summary.strip() or "\n" in summary.strip() \
                or len(summary.strip()) > MAX_SUMMARY:
            raise Invalid("follow-up {}: summary must be one line of 1 to {} characters".format(n, MAX_SUMMARY))
        if not isinstance(why, str) or not why.strip() or len(why.strip()) > MAX_WHY:
            raise Invalid("follow-up {}: why must be 1 to {} characters".format(n, MAX_WHY))
        if not isinstance(blocks, bool):
            raise Invalid("follow-up {}: blocks must be true or false".format(n))
        cleaned.append({"summary": summary.strip(), "why": why.strip(), "blocks": blocks})
    return cleaned


def folder(run_id: str) -> Path:
    return runs_dir() / run_id / "follow-ups"


def ref(run_id: str, file_id: str) -> str:
    return "{}{}:{}".format(PREFIX, run_id, file_id)


def parse_ref(source_ref: str) -> Optional[Tuple[str, str]]:
    """(run id, file id) for a follow-up pointer, else None."""
    if not isinstance(source_ref, str) or not source_ref.startswith(PREFIX):
        return None
    parts = source_ref[len(PREFIX):].split(":")
    if len(parts) != 2 or not RUN_ID.match(parts[0]) or not FILE_ID.match(parts[1]):
        return None
    return parts[0], parts[1]


def path_for(source_ref: str) -> Optional[Path]:
    found = parse_ref(source_ref)
    return folder(found[0]) / (found[1] + ".json") if found else None


def save(run_id: str, step: str, attempt: int, ticket: Optional[str], items: List[Dict[str, object]], at: str) -> List[str]:
    """Write one file per follow-up; returns their pointers. A file already there (a repeat record) is left alone."""
    refs = []
    target = folder(run_id)
    target.mkdir(parents=True, exist_ok=True)
    for n, item in enumerate(items, 1):
        file_id = "{}-{}-{}".format(step, attempt, n)
        path = target / (file_id + ".json")
        if not path.exists():
            _write(path, dict(item, id=file_id, run=run_id, step=step, attempt=attempt, origin=ticket, state="new",
                              intake_run=None, key=None, recorded_at=at))
        refs.append(ref(run_id, file_id))
    return refs


def load(source_ref: str) -> Optional[dict]:
    path = path_for(source_ref)
    if path is None:
        return None
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return doc if isinstance(doc, dict) else None


def load_all(run_id: str) -> List[dict]:
    """Every follow-up of the run, oldest first (by step file name order of recording)."""
    base = folder(run_id)
    if not base.is_dir():
        return []
    found = []
    for path in sorted(base.glob("*.json"), key=lambda p: p.stat().st_mtime_ns):
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(doc, dict) and doc.get("id"):
            found.append(doc)
    found.sort(key=lambda d: (str(d.get("recorded_at") or ""), str(d.get("id"))))
    return found


def update(source_ref: str, **changes) -> bool:
    """Change fields of one follow-up. True when it reads back with them."""
    path = path_for(source_ref)
    doc = load(source_ref)
    if path is None or doc is None:
        return False
    doc.update(changes)
    _write(path, doc)
    back = load(source_ref) or {}
    return all(back.get(k) == v for k, v in changes.items())


def _write(path: Path, doc: dict) -> None:
    tmp = path.with_name(".{}.{}.tmp".format(path.name, os.getpid()))
    tmp.write_text(json.dumps(doc, indent=1, sort_keys=True), encoding="utf-8")
    os.replace(str(tmp), str(path))


def is_done_status(status: str, category: str = "") -> bool:
    return (category or "").lower() == "done" or (status or "").strip().lower() in DONE_STATUSES


def blocking_open(doc: dict) -> bool:
    """A follow-up that still holds its run back."""
    return bool(doc.get("blocks")) and doc.get("state") in ("new", "submitted", "filed")


def settle_dropped(source_ref: str, intake_doc: Optional[dict]) -> bool:
    """Mark a submitted follow-up dropped when its intake run ended with no ticket. True when it was marked."""
    doc = load(source_ref) or {}
    if doc.get("state") != "submitted" or doc.get("key") or not intake_doc or not intake_doc.get("ended"):
        return False
    return update(source_ref, state="dropped", ended_as=intake_doc["ended"])
