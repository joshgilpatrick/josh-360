"""Collector `report`: one number or short code out of the report a job last wrote (JP-166).

The argument is `<report id> <dotted path>`, such as `doctor summary.fail`. The file is the laptop's own copy of the
report, `state/reports/<id>.json`, which `laptop/run_jobs.py` keeps beside the copy it publishes to `laptop-status`.
The path is followed through objects only, and the report id cannot name a file outside that folder.
"""
from __future__ import annotations

import json
import re

from . import reading

FIELDS = {"value": "value", "age_hours": "number"}
COUNTS_EVENTS = False
ARGUMENT = re.compile(r"^[a-z0-9][a-z0-9-]{0,63} [A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$")


def read(argument: str, since: str, deps) -> dict:
    try:
        if ARGUMENT.fullmatch(argument or "") is None:
            return reading.take(None, FIELDS)
        report_id, dotted = argument.split(" ", 1)
        path = reading.state_dir(deps) / "reports" / (report_id + ".json")
        current = json.loads(path.read_text(encoding="utf-8"))
        for part in dotted.split("."):
            if not isinstance(current, dict) or part not in current:
                return reading.take(None, FIELDS)
            current = current[part]
        age = max((deps.now().timestamp() - path.stat().st_mtime) / 3600.0, 0.0)
        return reading.take({"value": current, "age_hours": round(age, 2)}, FIELDS,
                            link="reports/{}.json on the laptop-status branch".format(report_id))
    except Exception:
        return reading.take(None, FIELDS)
