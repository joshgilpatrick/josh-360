"""The list of collectors a ticket's Validation section may name (JP-165; spec "Collectors").

Python 3.9, standard library only. A collector is a small read-only function (JP-166 builds them, one module each, in
this folder) that returns one reading: named numbers and short codes. This file holds only what the Ready check and
the watch must agree on: each collector's argument pattern, the fields it returns and whether it counts events. No
reader is imported here, so a ticket can name a collector the day it merges and the list loads with no reader built.

Every pattern here is used only through `fullmatch` (see `lib.validation_section.argument_ok`). In Python a pattern
ending in `$` also matches just before a trailing newline, so `match` or `search` would take `"pass\\n"` as a short code
and `"sample-job\\n"` as a job id.

Adding a collector: one module here with `read(argument, since)`, one entry in `DECLARED`, one row in the table in
graphs/contracts/validation-section.md, and its tests.
"""
from __future__ import annotations

import re
from typing import Dict

# A short code: what a reading may hold besides a number. Use only through `fullmatch`.
CODE = re.compile(r"^[A-Za-z0-9_.-]{1,32}$")

COMPARISONS = ("is", "is not", "is at least", "is at most", "is above", "is below")
ORDERING = COMPARISONS[2:]      # the comparisons that need two numbers

# name -> {"argument": a pattern for the whole argument, "fields": field -> "number" | "code" | "value",
#          "counts_events": whether the collector's `events` field counts what happened since the watch began}
DECLARED: Dict[str, dict] = {
    "job": {"argument": r"^[a-z0-9][a-z0-9-]{0,63}$",
            "fields": {"last_exit": "number", "hours_since_run": "number"}, "counts_events": False},
    "report": {"argument": r"^[a-z0-9][a-z0-9-]{0,63} [A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$",
               "fields": {"value": "value", "age_hours": "number"}, "counts_events": False},
    "doctor": {"argument": r"^[a-z][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$",
               "fields": {"status": "code"}, "counts_events": False},
    "ledger-runs": {"argument": r"^[a-z][a-z0-9-]{0,63}$",
                    "fields": {"events": "number", "success": "number", "neutral": "number", "needs_josh": "number"},
                    "counts_events": True},
    "jira-count": {"argument": r"^[^\r\n]{1,500}$",
                   "fields": {"count": "number", "events": "number"}, "counts_events": True},
    "github-runs": {"argument": r"^[\w.-]+/[\w.-]+ [\w.-]+\.ya?ml( [\w./-]+)?$",
                    "fields": {"events": "number", "failed": "number", "last": "code"}, "counts_events": True},
}
