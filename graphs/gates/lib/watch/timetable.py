"""When a watch begins, when its first check is due and when it ends (JP-166). Pure: no file, no clock, no network.

Times are timezone-aware datetimes; in files they are UTC text such as `2026-11-18T23:05:00Z`.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

NEVER_BEGAN_DAYS = 90     # a watch that has not begun this long after its round started ends as no_data
LOOK_SECONDS = 3600       # the watched ticket's status is looked at no more than once an hour between checks


def iso(when: datetime) -> str:
    return when.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse(text) -> Optional[datetime]:
    """UTC text back to an aware datetime; None when it is not a time."""
    if not isinstance(text, str) or not text:
        return None
    try:
        when = datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        try:
            when = datetime.fromisoformat(text)
        except ValueError:
            return None
        if when.tzinfo is None:
            return None
    return when.astimezone(timezone.utc)


def begins_at(starts_kind: str, starts_date: str, started_at: datetime) -> Optional[datetime]:
    """The moment the watch begins. `deployed`: when the round started. `date`: the start of that day by the machine's
    own time zone, or when the round started if that is later. `ticket`: not known yet (None): the watch script records
    it when it first reads the other ticket in Done. Anything else, or a date that is not one, is a ValueError."""
    if starts_kind == "deployed":
        return started_at
    if starts_kind == "ticket":
        return None
    if starts_kind == "date":
        midnight = datetime.strptime(starts_date, "%Y-%m-%d").astimezone(timezone.utc)   # a naive time is local time
        return max(midnight, started_at)
    raise ValueError("unknown start kind '{}'".format(starts_kind))


def first_check_at(begins: datetime, check_every_hours: int) -> datetime:
    """The first check is one interval after the watch begins, never at the beginning: a merge takes about ten minutes
    to install, and a reading taken before that would grade the old code."""
    return begins + timedelta(hours=check_every_hours)


def gave_up(begins: datetime, give_up_days: int, now: datetime) -> bool:
    """'Give up after' counts from the moment the watch begins, not from the start of the round."""
    return now >= begins + timedelta(days=give_up_days)


def never_began(started_at: datetime, now: datetime) -> bool:
    return now >= started_at + timedelta(days=NEVER_BEGAN_DAYS)
