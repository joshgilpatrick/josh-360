"""Collector `doctor`: the status one platform-doctor check had the last time the doctor ran (JP-166).

The argument is a check id such as `backfills.retire-session-atlas`. The file is the laptop's copy of the doctor job's
report, `state/reports/doctor.json`. The doctor runs once a day, so a report whose `time` is more than 36 hours old, or
has none, is not a reading: a status with no age would otherwise pass for ever.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone

from . import reading

FIELDS = {"status": "code"}
COUNTS_EVENTS = False
ARGUMENT = re.compile(r"^[a-z][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$")
MAX_AGE = timedelta(hours=36)


def read(argument: str, since: str, deps) -> dict:
    try:
        if ARGUMENT.fullmatch(argument or "") is None:
            return reading.take(None, FIELDS)
        document = json.loads((reading.state_dir(deps) / "reports" / "doctor.json").read_text(encoding="utf-8"))
        made = datetime.strptime(str(document.get("time")), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        if deps.now() - made > MAX_AGE:
            return reading.take(None, FIELDS)
        for entry in document.get("checks") or []:
            if isinstance(entry, dict) and entry.get("id") == argument:
                return reading.take({"status": entry.get("status")}, FIELDS,
                                    link="reports/doctor.json on the laptop-status branch")
        return reading.take(None, FIELDS)
    except Exception:
        return reading.take(None, FIELDS)
