"""What every collector returns, and the one place a value is let through (JP-166). Python 3.9, standard library only.

A reading is `{"fields": {...}, "link": ""}`. It always has every declared field, and a field that could not be read is
None ("unknown", never a pass or a fail). A value is an int, a finite float, or a short code: nothing copied from the
system that was read, so a reading cannot carry patient data. Every collector returns through `take`.
"""
from __future__ import annotations

import math
import re
from pathlib import Path
from typing import Dict, Optional

# Used only through fullmatch: a pattern ending in `$` also matches before a trailing newline in Python.
CODE = re.compile(r"^[A-Za-z0-9_.-]{1,32}$")


def fits(value, kind: str) -> bool:
    """True when the value is allowed in a field of this kind: `number`, `code` (a short code) or `value` (either)."""
    if isinstance(value, bool):
        return False
    is_number = isinstance(value, (int, float)) and (not isinstance(value, float) or math.isfinite(value))
    is_code = isinstance(value, str) and CODE.fullmatch(value) is not None
    if kind == "number":
        return is_number
    if kind == "code":
        return is_code
    if kind == "value":
        return is_number or is_code
    return False


def take(raw: Optional[dict], fields: Dict[str, str], link: str = "") -> dict:
    """A reading: for each declared field the raw value when it fits the field's kind, else None. Nothing else in `raw`
    is carried. `raw` of None is every field unknown."""
    source = raw if isinstance(raw, dict) else {}
    return {"fields": {name: (source[name] if name in source and fits(source[name], kind) else None)
                       for name, kind in fields.items()},
            "link": link}


def state_dir(deps) -> Path:
    """The laptop's state folder, the one `laptop.common.state_dir()` gives, from the environment `deps` carries."""
    home = deps.environ.get("JOSH360_HOME") or "~/.josh-360"
    return Path(home).expanduser().absolute() / "state"
