"""Jira timestamps (JP-122). Python 3.9: `%z` takes "+0000" and "-0800"."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional


def parse(text: Optional[str]) -> Optional[datetime]:
    """The moment a Jira timestamp names, or None when it does not read. Always timezone-aware."""
    if not text:
        return None
    for form in ("%Y-%m-%dT%H:%M:%S.%f%z", "%Y-%m-%dT%H:%M:%S%z"):
        try:
            return datetime.strptime(text.strip(), form)
        except ValueError:
            continue
    try:
        return datetime.strptime(text.strip().rstrip("Z"), "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def later(a: Optional[str], b: Optional[str]) -> bool:
    """True when a is strictly later than b. Unreadable times are never later: unknown does not order."""
    first, second = parse(a), parse(b)
    return bool(first and second and first > second)
