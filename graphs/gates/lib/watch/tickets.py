"""What the watch reads about tickets (JP-166). Reads only. A read that fails is unknown, never a missing ticket and
never a ticket that moved: the watch keeps waiting (the action-triage#88 rule).
"""
from __future__ import annotations

from typing import Optional


def status(jira, key: str) -> Optional[str]:
    """The ticket's status name; None when the read failed or the ticket is not there."""
    try:
        found = jira.get(key, ["status"])
    except Exception:
        return None
    name = (found or {}).get("status")
    return name if isinstance(name, str) and name else None


def state(jira, key: str) -> str:
    """`done` (status Done, or any status in the done category except Cancelled), `cancelled`, `open`, `missing` (Jira
    says the ticket does not exist) or `unknown` (the read failed)."""
    try:
        found = jira.get(key, ["status"])
        if not found:
            return "missing" if jira.exists(key) is False else "unknown"
    except Exception:
        return "unknown"
    name = found.get("status") or ""
    if not name:
        return "unknown"
    if name == "Cancelled":
        return "cancelled"
    if name == "Done" or found.get("status_category") == "done":
        return "done"
    return "open"
