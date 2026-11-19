"""How one check is judged and how a whole check log is graded (JP-166). Pure: no file, no clock, no network.

`plan` is the watch file (`criteria`, `complete_kind`, `complete_n`, `fail_after`); `lines` is the check log, one dict
per line. An unknown reading is never a pass and never a fail: it neither counts toward a run nor breaks one.
"""
from __future__ import annotations

import math
from typing import Dict, List, Optional, Tuple

DEFAULT_FAIL_AFTER = 3


def _number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and \
        (not isinstance(value, float) or math.isfinite(value))


def holds(got, comparison: str, want) -> Optional[bool]:
    """Whether `got <comparison> want` is true; None when it cannot be said (nothing was read, or an ordering
    comparison was given something that is not a number)."""
    if got is None:
        return None
    if comparison in ("is", "is not"):
        same = got == want if _number(got) and _number(want) else str(got) == str(want)
        return same if comparison == "is" else not same
    if not (_number(got) and _number(want)):
        return None
    if comparison == "is at least":
        return got >= want
    if comparison == "is at most":
        return got <= want
    if comparison == "is above":
        return got > want
    if comparison == "is below":
        return got < want
    return None


def judge(criterion: dict, reading: dict) -> str:
    """`pass`, `fail` or `unknown` for one measured criterion: a fail when any `Then` is false, else unknown when any
    could not be said, else a pass."""
    fields = (reading or {}).get("fields") or {}
    answers = [holds(fields.get(check["field"]), check["comparison"], check["value"])
               for check in criterion.get("checks") or []]
    if not answers:
        return "unknown"
    if any(answer is False for answer in answers):
        return "fail"
    if any(answer is None for answer in answers):
        return "unknown"
    return "pass"


def check_result(results: List[str]) -> str:
    """A check fails when any criterion failed; else it is unknown when any could not be read; else it passes."""
    if "fail" in results:
        return "fail"
    if not results or "unknown" in results:
        return "unknown"
    return "pass"


def _measured(plan: dict) -> List[dict]:
    return [c for c in plan.get("criteria") or [] if not c.get("manual")]


def events_ready(plan: dict, readings: Dict[str, dict]) -> bool:
    """True when every measured criterion has counted at least `complete_n` events."""
    measured = _measured(plan)
    if not measured:
        return False
    need = int(plan.get("complete_n") or 0)
    for criterion in measured:
        events = ((readings.get(criterion["id"]) or {}).get("fields") or {}).get("events")
        if not _number(events) or events < need:
            return False
    return True


def _checks(lines: List[dict]) -> List[dict]:
    return [line for line in lines if line.get("kind") == "check"]


def grade(lines: List[dict], plan: dict, gave_up: bool) -> Optional[Tuple[str, str]]:
    """`(result, reason)` when the log ends the watch, else None (not yet). A met watch with a manual criterion is
    `needs_josh`: a script cannot measure that criterion, so Josh confirms it once."""
    checks = _checks(lines)
    if plan.get("complete_kind") == "events":
        last = checks[-1]["result"] if checks else ""
        if last == "pass":
            outcome = ("met", "events")
        elif last == "fail":
            outcome = ("not_met", "events")
        elif gave_up:
            return ("no_data", "gave_up")
        else:
            return None
    else:
        known = [line["result"] for line in checks if line.get("result") in ("pass", "fail")]
        need = int(plan.get("complete_n") or 1)
        fail_after = int(plan.get("fail_after") or DEFAULT_FAIL_AFTER)
        if len(known) >= need and all(r == "pass" for r in known[-need:]):
            outcome = ("met", "streak")
        elif len(known) >= fail_after and all(r == "fail" for r in known[-fail_after:]):
            return ("not_met", "fail_after")
        elif gave_up:
            return ("not_met" if "fail" in known else "no_data", "gave_up")
        else:
            return None
    if outcome[0] == "met" and any(c.get("manual") for c in plan.get("criteria") or []):
        return ("needs_josh", outcome[1])
    return outcome


def tally(plan: dict, lines: List[dict]) -> List[dict]:
    """One entry per criterion, from the check lines: how many checks it was in, how many passed, failed and could not
    be read, its current run of passes (unknowns skipped) and the fields and link of its newest reading."""
    out = []
    checks = _checks(lines)
    for criterion in plan.get("criteria") or []:
        entries = []
        if not criterion.get("manual"):
            entries = [line["criteria"][criterion["id"]] for line in checks
                       if isinstance((line.get("criteria") or {}).get(criterion["id"]), dict)]
        results = [entry.get("result") for entry in entries]
        run = 0
        for result in reversed(results):
            if result == "pass":
                run += 1
            elif result == "fail":
                break
        last = entries[-1] if entries else {}
        out.append({"id": criterion["id"], "checks": len(entries), "passed": results.count("pass"),
                    "failed": results.count("fail"), "unknown": len(results) - results.count("pass") - results.count("fail"),
                    "streak": run, "last": dict(last.get("fields") or {}), "link": str(last.get("link") or "")})
    return out


def met_on(lines: List[dict]) -> int:
    """The number of the last check taken: 'met on check 9'."""
    checks = _checks(lines)
    return int(checks[-1].get("n") or 0) if checks else 0
