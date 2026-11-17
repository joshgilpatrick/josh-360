"""What the pull request review gates share (JP-115): the cursor file, the label moves, the audit's verdict.

Python 3.9, standard library only. The review itself is the laptop's PR audit (action-triage); this file only reads what
it leaves on the pull request: labels, a marked comment, check results. The cursor `pr-cursor.json` in the run's work
folder remembers which pull request, which head and when the round was queued, so a wait can tell this round's verdict
from an old one.
"""
from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from lib import dev_github
from lib.dev_github import Check, PrComment

MARKER = "<!-- action-triage-audit:"
STALE_HOURS = 48
DEFAULT_BOTS = ("eventus-action-agent", "eventuswh-apps-action-agent", "joshgilpatrick-action-agent")
UNCOUNTED = 4   # a verdict that cannot be counted gets another round, never one fewer


def stamp(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_time(text: Optional[str]) -> Optional[datetime]:
    if not text:
        return None
    try:
        moment = datetime.fromisoformat(text.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def read_cursor(work_dir: Path) -> Optional[dict]:
    try:
        doc = json.loads((Path(work_dir) / "pr-cursor.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return doc if isinstance(doc, dict) and doc.get("queued_at") else None


def write_cursor(work_dir: Path, repo: str, number: int, head: str, queued_at: str) -> dict:
    old = read_cursor(work_dir)
    doc = {"repo": repo, "pr": int(number), "head": head, "queued_at": queued_at,
           "round": int((old or {}).get("round", 0)) + 1}
    path = Path(work_dir) / "pr-cursor.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(doc, indent=1, sort_keys=True), encoding="utf-8")
    os.replace(str(tmp), str(path))
    return doc


def queue(github, number: int) -> None:
    """Put the pull request in the audit's queue: the labels exist, the terminal ones are gone, the trigger is on.
    `audit-in-progress` and `audit-blocked` are never touched: the audit clears them itself."""
    github.ensure_labels()
    labels = github.pr(number).labels
    for label in (dev_github.CHANGES, dev_github.READY):
        github.remove_label(number, label)
    if dev_github.TRIGGER not in labels:
        github.add_label(number, dev_github.TRIGGER)


def audit_bots(environ) -> List[str]:
    named = (environ or {}).get("JOSH360_AUDIT_BOTS")
    names = [n.strip() for n in named.split(",")] if named else list(DEFAULT_BOTS)
    return [_login(n) for n in names if n.strip()]


def _login(name: str) -> str:
    low = (name or "").strip().lower()
    return low[:-5] if low.endswith("[bot]") else low


def verdict(comments: List[PrComment], since: str, bots: List[str]) -> Optional[PrComment]:
    """The newest comment that holds the audit marker, is by an audit bot and is newer than `since`."""
    floor = parse_time(since)
    best, best_time = None, None
    for c in comments:
        when = parse_time(c.created)
        if MARKER not in c.body or _login(c.author) not in bots or when is None:
            continue
        if floor is not None and when <= floor:
            continue
        if best_time is None or when >= best_time:
            best, best_time = c, when
    return best


_HEADING = re.compile(r"^#{2,4}\s+(?:finding|\d)", re.IGNORECASE)
_NONE = re.compile(r"\bno\s+(?:[A-Za-z-]+\s+){0,3}?findings?\b", re.IGNORECASE)
_NUMBER = re.compile(r"\b(\d+)\s+(?:[A-Za-z-]+\s+){0,3}?findings?\b", re.IGNORECASE)


def count_findings(body: str) -> Optional[int]:
    """How many findings a verdict holds, or None when it cannot be told. Rules in order: finding headings (optional
    ones not counted); else the numbers in phrases like `3 findings` (added together: the safe direction); else
    `no findings` is 0."""
    headings = [line for line in (body or "").splitlines() if _HEADING.match(line.strip())]
    if headings:
        return sum(1 for h in headings if "optional" not in h.lower())
    numbers = [int(n) for n in _NUMBER.findall(body or "")]
    if numbers:
        return sum(numbers)
    if _NONE.search(body or ""):
        return 0
    return None


def check_state(checks: List[Check]) -> str:
    """none, pending, failed or green, counting only the latest-started check of each name."""
    latest = {}
    for c in checks:
        if c.name not in latest or (parse_time(c.started) or datetime.min.replace(tzinfo=timezone.utc)) >= \
                (parse_time(latest[c.name].started) or datetime.min.replace(tzinfo=timezone.utc)):
            latest[c.name] = c
    if not latest:
        return "none"
    buckets = [c.bucket for c in latest.values()]
    if any(b in ("fail", "cancel") for b in buckets):
        return "failed"
    if all(b in ("pass", "skipping") for b in buckets):
        return "green"
    return "pending"


def failing_names(checks: List[Check]) -> List[str]:
    latest = {}
    for c in checks:
        if c.name not in latest or (parse_time(c.started) or datetime.min.replace(tzinfo=timezone.utc)) >= \
                (parse_time(latest[c.name].started) or datetime.min.replace(tzinfo=timezone.utc)):
            latest[c.name] = c
    return [n for n, c in latest.items() if c.bucket in ("fail", "cancel")]


def checks_grace(environ) -> int:
    try:
        return max(int((environ or {}).get("JOSH360_CHECKS_GRACE") or 30), 0)
    except ValueError:
        return 30
