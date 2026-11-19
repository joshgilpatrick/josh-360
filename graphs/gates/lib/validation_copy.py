"""The validation graph's comments, evidence table, card and Bug, word for word (design spec, "Exact copy"; JP-167).

Python 3.9, standard library only. Every comment has the workflow's `result | evidence | next gate` shape, and none of
them holds a blank line, so a comment read back from Jira (blocks joined by one line break) equals the text posted and
`say(..., once=True)` can tell it already stands. The text here is what gets posted: a change to it is a change to
the spec.

Everything built here is a count, a short code, a link or the ticket's own criteria text. A reading never holds text
copied from the system it read (`lib.collectors.reading.take`), so nothing here can carry a patient's details.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Dict, List

from lib.collectors import reading

CARD_LIMIT = 4000        # the walker shows Josh no more than this much of a card
CELL_LIMIT = 160
LINK_LIMIT = 300
TABLE_HEAD = ["Criterion", "Checks", "Passed", "Failed", "Unknown", "Last reading", "Link"]
MANUAL_ROW = "for Josh to confirm"


def _plural(n: int, one: str, many: str) -> str:
    return "{} {}".format(n, one if n == 1 else many)


def interval(hours: int) -> str:
    """`1 hour`, `6 hours`, `1 day`, `3 days`: days when the hours divide by 24."""
    hours = int(hours)
    if hours % 24 == 0:
        return _plural(hours // 24, "day", "days")
    return _plural(hours, "hour", "hours")


def start(n: int, check_every_hours: int, complete_when: str, give_up_days: int, first_check: str) -> str:
    """The start comment. `first_check` is a local date and time, or `one check after JP-170 is Done`."""
    return ("Watching this change in production | {}; a check every {}; complete when {}; gives up after {} | "
            "next gate: first check due {}.").format(_plural(n, "criterion", "criteria"), interval(check_every_hours),
                                                     complete_when, _plural(int(give_up_days), "day", "days"),
                                                     first_check)


def met(complete_when: str, check: int, round_no: int) -> str:
    return "Validated in production | {}, reached on check {} of round {} | next gate: none.".format(
        complete_when, check, round_no)


def unwatched(reason: str) -> str:
    return "Nothing to watch | {} | next gate: none.".format(reason)


def not_met(failed_text: str, bug_key: str) -> str:
    return "Not met in production | {} | next gate: {}; the watch starts again when it ships.".format(
        failed_text, bug_key)


def accepted(date: str, line: str) -> str:
    return "Closed on Josh's answer ({}) | the watch had not shown the criteria met: {} | next gate: none.".format(
        date, line)


def hold() -> str:
    return ("Watch stopped at Josh's request | this ticket stays in Deployed and is flagged, so nothing is watching "
            "it | next gate: clear the flag to start a fresh watch, or move the ticket.")


def no_section() -> str:
    return "the ticket has no Validation section"


def says_no(reason: str) -> str:
    return 'the ticket says "Needed: no": {}'.format(reason)


# -- the evidence table ---------------------------------------------------------------------------------------------
def _text(value, limit: int = CELL_LIMIT) -> str:
    """Text as one table cell: one line, no pipe, shortened."""
    cell = " ".join(str(value or "").split()).replace("|", "/")
    return cell if len(cell) <= limit else cell[:limit - 1] + "…"


def _last(fields) -> str:
    """The newest reading as `name value, name value`: only names and values that are numbers or short codes."""
    if not isinstance(fields, dict):
        return ""
    shown = ["{} {}".format(name, value) for name, value in fields.items()
             if isinstance(name, str) and reading.CODE.fullmatch(name) and reading.fits(value, "value")]
    return ", ".join(shown)


def _count(value) -> str:
    return str(value) if isinstance(value, int) and not isinstance(value, bool) else "0"


def evidence_table(criteria: List[dict], tally: List[dict]) -> str:
    """A Markdown table, one row per criterion: checks made, passed, failed, unknown, the last reading, a link."""
    counts = {t.get("id"): t for t in tally or [] if isinstance(t, dict)}
    rows = ["| " + " | ".join(TABLE_HEAD) + " |", "| " + " | ".join("---" for _ in TABLE_HEAD) + " |"]
    for criterion in criteria or []:
        name = _text(criterion.get("name") or criterion.get("id"))
        if criterion.get("manual"):
            rows.append("| {} | {} | | | | | |".format(name, MANUAL_ROW))
            continue
        row = counts.get(criterion.get("id")) or {}
        rows.append("| {} | {} | {} | {} | {} | {} | {} |".format(
            name, _count(row.get("checks")), _count(row.get("passed")), _count(row.get("failed")),
            _count(row.get("unknown")), _last(row.get("last")), _text(row.get("link"), LINK_LIMIT)))
    return "\n".join(rows)


def _names(criteria: List[dict]) -> Dict[str, str]:
    return {c.get("id"): _text(c.get("name") or c.get("id")) for c in criteria or [] if isinstance(c, dict)}


def failed_text(criteria: List[dict], failed: List[dict]) -> str:
    """`<name>: <failed> of <checks> checks failed`, joined with `; `."""
    names = _names(criteria)
    return "; ".join("{}: {} of {} checks failed".format(names.get(f.get("id"), f.get("id")), _count(f.get("failed")),
                                                          _count(f.get("checks"))) for f in failed or [])


# -- the card Josh reads --------------------------------------------------------------------------------------------
NEVER_BEGAN_WHY = {
    "starts_cancelled": "the ticket it waits for was cancelled",
    "starts_missing": "the ticket it waits for does not exist",
    "never_began": "90 days passed and it had still not begun",
}


def card(case: str, **parts) -> str:
    """What Josh reads under the one question. The first line is one sentence saying what happened. `case` is one of
    the six rows of the spec's table: no_readings, never_began, manual, unreadable, fix_cancelled, fix_shipped."""
    key = parts.get("key", "")
    if case == "no_readings":
        names = [_text(n) for n in parts.get("names") or []]
        lines = ["The watch on {} gave up with no readings for: {}.".format(key, "; ".join(names) or "a criterion"),
                 "The collector for each of these could not read, so every check of them came back unknown."]
        lines += ["- " + n for n in names]
    elif case == "never_began":
        why = NEVER_BEGAN_WHY.get(parts.get("reason", ""), "it cannot begin")
        lines = ["The watch on {} never began: it was waiting for \"Starts: {}\", and {}.".format(
            key, _text(parts.get("starts")), why),
            "No reading was taken."]
    elif case == "manual":
        statements = [_text(s, 300) for s in parts.get("statements") or []]
        lines = ["Every scripted criterion on {} is met; for Josh to confirm: {}.".format(key, "; ".join(statements)),
                 "Answer accept if each of these holds, or watch again or stop if not:"]
        lines += ["- " + s for s in statements]
    elif case == "unreadable":
        lines = ["The Validation section on {} could not be read, so nothing is being watched.".format(key)]
        for p in parts.get("problems") or []:
            lines.append("- {} | what would pass: {}".format(_text(p.get("found"), 200), _text(p.get("needed"), 200)))
    elif case == "fix_cancelled":
        names = [_text(n) for n in parts.get("names") or []]
        lines = ["{} was cancelled, so the criteria on {} that failed are still not met.".format(
            parts.get("bug_key", "The Bug"), key),
            "Still failing: " + ("; ".join(names) or "see the evidence table on the ticket") + "."]
    elif case == "fix_shipped":
        rounds = [_text(r, 300) for r in parts.get("rounds") or []]
        lines = ["{} shipped, but the watch on {} has failed in {} so far.".format(
            parts.get("bug_key", "The fix"), key, _plural(len(rounds), "round", "rounds"))]
        lines += ["- round {}: {}".format(i + 1, r) for i, r in enumerate(rounds)]
    else:
        raise ValueError("unknown card case '{}'".format(case))
    text = "\n".join(lines)
    return text if len(text) <= CARD_LIMIT else text[:CARD_LIMIT - 1] + "…"


def write_card(work_dir: Path, text: str) -> str:
    """Write `<work>/watch/card.md` (every card rewrites this one file) and return its path."""
    path = Path(work_dir) / "watch" / "card.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text.rstrip("\n") + "\n", encoding="utf-8")
    os.replace(str(tmp), str(path))
    return str(path)


# -- the Bug a failed watch files ------------------------------------------------------------------------------------
def _restated(key: str, criterion: dict) -> str:
    lines = ["@e2e", "Scenario: " + _text(criterion.get("name") or criterion.get("id")),
             "  Given {} is in production".format(key),
             "  When the watch reads {} {}".format(criterion.get("collector"), criterion.get("argument"))]
    for index, check in enumerate(criterion.get("checks") or []):
        lines.append("  {} {} {} {}".format("Then" if index == 0 else "And", check.get("field"),
                                             check.get("comparison"), check.get("value")))
    return "\n".join(lines)


def bug_ticket(key: str, system_label: str, criteria: List[dict], failed: List[dict]) -> dict:
    """A proposal-shaped Bug for `adf.ticket_description`: the sections the spec lists, and nothing else. Triage fills
    whatever its checklist still asks for."""
    by_id = {c.get("id"): c for c in criteria or [] if isinstance(c, dict)}
    failing = [by_id[f.get("id")] for f in failed or [] if f.get("id") in by_id]
    first = failing[0] if failing else (criteria or [{}])[0]
    labels = ["validation-failure"] + ([system_label] if system_label else [])
    return {
        "type": "Bug",
        "summary": "{} did not meet its validation: {}".format(key, _text(first.get("name") or first.get("id"))),
        "labels": labels,
        "sections": {
            "goal": "{}'s validation criteria are met in production".format(key),
            "first_step": "Read {}'s Validation section and the evidence table in its last comment".format(key),
            "current_behaviour": failed_text(criteria, failed),
            "acceptance_criteria": "\n\n".join(_restated(key, c) for c in failing),
            "validation": "- Needed: no. The watch on {} proves this fix.".format(key),
            "parent_or_related": key,
        },
    }
