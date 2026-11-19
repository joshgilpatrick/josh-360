"""Collector `job`: did a background job run clean, and how long ago (JP-166).

Reads the job runner's state file, `state/jobs-state.json`: `{"<id>": {"last_run": <epoch seconds>, "last_result": <exit>}}`.
"""
from __future__ import annotations

import json
import re

from . import reading

FIELDS = {"last_exit": "number", "hours_since_run": "number"}
COUNTS_EVENTS = False
ARGUMENT = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


def _number(value) -> bool:
    return reading.fits(value, "number")


def read(argument: str, since: str, deps) -> dict:
    try:
        if ARGUMENT.fullmatch(argument or "") is None:
            return reading.take(None, FIELDS)
        text = (reading.state_dir(deps) / "jobs-state.json").read_text(encoding="utf-8")
        record = json.loads(text).get(argument)
        if not isinstance(record, dict) or not _number(record.get("last_run")) or not _number(record.get("last_result")):
            return reading.take(None, FIELDS)
        hours = (deps.now().timestamp() - float(record["last_run"])) / 3600.0
        return reading.take({"last_exit": record["last_result"], "hours_since_run": round(max(hours, 0.0), 2)}, FIELDS)
    except Exception:   # a collector never raises: anything it cannot read is unknown
        return reading.take(None, FIELDS)
