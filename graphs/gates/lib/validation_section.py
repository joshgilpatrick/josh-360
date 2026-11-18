"""The one parser of a ticket's Validation section (JP-165; spec "The Validation section of a ticket" and "How a script
reads the section"; contract graphs/contracts/validation-section.md).

Python 3.9, standard library only. The Ready check, the validation graph's first step and the movers' rule all read the
section through here, so a section that passed Ready is one the graph can read. The argument on a `When` line is kept as
text: it is never split, expanded or evaluated here, and no pattern is used except through `fullmatch`.

    parse(description, key)  -> the parsed section (a dict, see PARSED below)
    parse_text(body, key)    -> the same for a section's body alone; None is "no section"
    canonical(text)          -> a proposal's text as a section body (the scenarios fenced)
    route(section)           -> "not_needed", "watch" or "unreadable"
    needs_watch(description) -> True when the section says Needed: yes, whatever else is wrong with it
    split(body)              -> (the field lines without list markers, the gherkin block's text or "")
    read_starts(value), read_complete_when(value), argument_ok(collector, argument)

A problem is `{"item": "V3", "where": "Validation", "found": ..., "needed": ...}`, the shape of
`lib.triage.checklist.failure`, so the Ready check can return it unchanged. V1 to V7 are the items of the spec's table.
"""
from __future__ import annotations

import datetime
import hashlib
import re
from typing import Dict, List, Optional, Tuple

from lib import ticket_text
from lib.collectors import CODE, COMPARISONS, DECLARED, ORDERING
from lib.triage.gherkin import find_gherkin_blocks, strip_blocks

WHERE = "Validation"
_MARKER = re.compile(r"^\s*(?:[-*•]\s+)")
_FIELD = re.compile(r"^([A-Za-z][A-Za-z ]*?)\s*:\s*(.*)$")
FIELDS = ("needed", "starts", "check every", "complete when", "give up after", "fail after")
_STARTS_DEPLOYED = re.compile(r"at deployed", re.IGNORECASE)
_STARTS_DATE = re.compile(r"on (\d{4})-(\d{2})-(\d{2})", re.IGNORECASE)
_STARTS_TICKET = re.compile(r"after ((?-i:[A-Z][A-Z0-9]+-[1-9][0-9]*)) is done", re.IGNORECASE)
_EVERY = re.compile(r"(\d+) (hours?|days?)", re.IGNORECASE)
_STREAK = re.compile(r"(\d+) checks? in a row pass", re.IGNORECASE)
_EVENTS = re.compile(r"after (\d+) events?", re.IGNORECASE)
_GIVE_UP = re.compile(r"(\d+) days?", re.IGNORECASE)
_FAIL_AFTER = re.compile(r"(\d+) checks? in a row fail", re.IGNORECASE)
_NEEDED_NO = re.compile(r"no(?:[.:;,—–-]\s*|\s+|$)(.*)", re.IGNORECASE | re.DOTALL)
_STEP = re.compile(r"^(Given|When|Then|And|But)\b\s*(.*)$")
_SCENARIO = re.compile(r"^Scenario\s*:\s*(.*)$", re.IGNORECASE)
_WHEN = re.compile(r"^the watch reads (\S+)(?: (.*))?$")
_THEN = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*) (" + "|".join(sorted(COMPARISONS, key=len, reverse=True)) + r") (.+)$")
_CONFIRM = re.compile(r"^Josh confirms that (.+)$")
_NUMBER = re.compile(r"-?\d+(?:\.\d+)?")
HOURS_MAX = 168            # "Check every": 1 hour to 7 days
GIVE_UP_MAX = 90
DEFAULT_FAIL_AFTER = 3
MIN_REASON_WORDS = 4

# Shown by the V3 problems; the `needed` text of each field's own form.
FORMS = {
    "starts": "Write 'at Deployed', 'on <YYYY-MM-DD>' (a real date) or 'after <KEY> is Done' (another ticket).",
    "check every": "Write '<n> hours' or '<n> days', from 1 hour to 7 days.",
    "complete when": "Write '<n> checks in a row pass' or 'after <n> events', with n of at least 1.",
    "give up after": "Write '<n> days', from 1 to 90.",
    "fail after": "Write '<n> checks in a row fail', with n of at least 1, or leave the line out.",
}
LABELS = {"starts": "Starts", "check every": "Check every", "complete when": "Complete when",
          "give up after": "Give up after", "fail after": "Fail after"}


def problem(item: str, found: str, needed: str) -> Dict[str, str]:
    found = ticket_text.collapse(found)
    if len(found) > 200:
        found = found[:199] + "…"
    return {"item": item, "where": WHERE, "found": found or "missing", "needed": needed}


def argument_ok(collector: str, argument: str) -> bool:
    """True only when the collector is on the list and its pattern matches the whole argument, by `fullmatch`. A
    pattern written with `$` would take a trailing newline without it, so nothing here uses `match` or `search`."""
    entry = DECLARED.get(collector) if isinstance(collector, str) else None
    return bool(entry) and isinstance(argument, str) and \
        re.fullmatch(entry["argument"], argument, re.ASCII) is not None


def split(body: str) -> Tuple[List[str], str]:
    """The field lines (list markers removed, empty lines dropped) and the text of the gherkin block, or "" when the
    section has none. More than one block are joined, so no scenario is left unread."""
    blocks = find_gherkin_blocks(body or "")
    lines = []
    for raw in strip_blocks(body or "").replace("\r\n", "\n").split("\n"):
        line = _MARKER.sub("", raw).strip()
        if line:
            lines.append(line)
    return lines, "\n".join(blocks)


def canonical(text: Optional[str]) -> str:
    """A proposal's Validation text as the section body: the field lines, then the scenarios in a gherkin fence. A
    proposal may leave the fence out (the Acceptance criteria text of a proposal has none); the scenarios then start
    at the first line that is a tag, a Feature or a Scenario."""
    body = (text or "").replace("\r\n", "\n").strip("\n")
    if find_gherkin_blocks(body):
        return body
    lines = body.split("\n")
    for index, line in enumerate(lines):
        if re.match(r"^\s*(?:@|Feature\s*:|Scenario\s*:)", line):
            head = "\n".join(lines[:index]).rstrip("\n")
            return (head + "\n\n" if head else "") + "```gherkin\n" + "\n".join(lines[index:]).strip("\n") + "\n```"
    return body


def read_starts(value: str) -> Optional[Tuple[str, str]]:
    """("deployed", ""), ("date", "2026-12-01") or ("ticket", "JP-170"); None when the value is in none of the forms."""
    text = value or ""
    if _STARTS_DEPLOYED.fullmatch(text):
        return "deployed", ""
    found = _STARTS_DATE.fullmatch(text)
    if found:
        try:
            return "date", datetime.date(int(found.group(1)), int(found.group(2)), int(found.group(3))).isoformat()
        except ValueError:
            return None
    found = _STARTS_TICKET.fullmatch(text)
    return ("ticket", found.group(1)) if found else None


def read_complete_when(value: str) -> Optional[Tuple[str, int]]:
    """("streak", 7) or ("events", 20); None when the value is in neither form or the number is under 1."""
    text = value or ""
    for kind, pattern in (("streak", _STREAK), ("events", _EVENTS)):
        found = pattern.fullmatch(text)
        if found and int(found.group(1)) >= 1:
            return kind, int(found.group(1))
    return None


def _read_every(value: str) -> Optional[int]:
    found = _EVERY.fullmatch(value or "")
    if not found:
        return None
    hours = int(found.group(1)) * (24 if found.group(2).lower().startswith("day") else 1)
    return hours if 1 <= hours <= HOURS_MAX else None


def _read_count(pattern, value: str, low: int, high: Optional[int] = None) -> Optional[int]:
    found = pattern.fullmatch(value or "")
    if not found:
        return None
    n = int(found.group(1))
    return n if n >= low and (high is None or n <= high) else None


def _version(body: str) -> str:
    text = "\n".join(line.rstrip(" \t") for line in (body or "").splitlines())
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def _empty(present: bool) -> dict:
    return {"present": present, "needed": "", "reason": "", "starts": "", "starts_kind": None, "starts_date": "",
            "starts_ticket": "", "check_every_hours": None, "complete_when": "", "complete_kind": None,
            "complete_n": None, "give_up_days": None, "fail_after": DEFAULT_FAIL_AFTER, "criteria": [],
            "section_version": "", "problems": []}


def _fields(lines: List[str]) -> Tuple[Dict[str, str], List[str], List[str]]:
    """(the value of each known field, the names written twice, the lines that are not a known field)."""
    values: Dict[str, str] = {}
    twice: List[str] = []
    other: List[str] = []
    for line in lines:
        found = _FIELD.match(line.replace("**", "").strip())
        name = found.group(1).strip().lower() if found else ""
        if name not in FIELDS:
            other.append(line)
        elif name in values:
            if name not in twice:
                twice.append(name)
        else:
            values[name] = found.group(2).strip()
    return values, twice, other


def _is_number(text: str) -> bool:
    return _NUMBER.fullmatch(text) is not None


def _number(text: str):
    return float(text) if "." in text else int(text)


def _read_scenarios(block: str) -> List[dict]:
    """Each scenario of the block: its name, tags and steps (`And` and `But` take the keyword before them)."""
    scenarios: List[dict] = []
    tags: List[str] = []
    current: Optional[dict] = None
    last = ""
    for raw in (block or "").replace("\r\n", "\n").split("\n"):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("@"):
            tags.extend(re.findall(r"@[\w-]+", line))
            continue
        named = _SCENARIO.match(line)
        if named:
            current = {"name": ticket_text.collapse(named.group(1)), "tags": tags, "steps": []}
            scenarios.append(current)
            tags, last = [], ""
            continue
        step = _STEP.match(line)
        if step and current is not None:
            word = last if step.group(1) in ("And", "But") else step.group(1)
            last = word or last
            current["steps"].append((word, step.group(2).strip()))
        elif not line.lower().startswith(("feature:", "background:")):
            tags = []
    return scenarios


def _value(text: str):
    """The value of a Then line: a number when the ticket wrote one, else the word as written; None when neither."""
    if _is_number(text):
        return _number(text)
    return text if CODE.fullmatch(text) else None


def _measured(scenario: dict, name: str, ident: str, problems: List[dict]) -> Optional[dict]:
    steps = scenario["steps"]
    where = 'Scenario "{}"'.format(name)
    bad = len(problems)
    givens = [s for s in steps if s[0] == "Given"]
    whens = [s for s in steps if s[0] == "When"]
    if givens:
        problems.append(problem("V5", where + " has a Given line.",
                                "A criterion has one When line, 'When the watch reads <collector> <argument>', and Then lines."))
    if len(whens) != 1:
        problems.append(problem("V5", where + " has {} When lines.".format(len(whens)),
                                "Give it exactly one line: When the watch reads <collector> <argument>."))
        return None
    when = _WHEN.match(whens[0][1])
    collector, argument = (when.group(1), (when.group(2) or "").strip()) if when else ("", "")
    if not when or collector not in DECLARED:
        problems.append(problem("V5", where + " reads '{}'.".format(collector or whens[0][1]),
                                "Name a collector on the list: " + ", ".join(DECLARED) + "."))
        return None
    if not argument_ok(collector, argument):
        problems.append(problem("V5", where + " gives {} the argument '{}'.".format(collector, argument),
                                "Give {} an argument in its own shape (graphs/contracts/validation-section.md).".format(collector)))
        return None
    fields = DECLARED[collector]["fields"]
    checks: List[dict] = []
    thens = [s for s in steps if s[0] == "Then"]
    if not thens:
        problems.append(problem("V6", where + " has no Then line.", "Add Then <field> <comparison> <value>."))
    for _, text in thens:
        found = _THEN.match(text)
        if not found or found.group(1) not in fields:
            problems.append(problem("V6", where + " says '{}'.".format(text),
                                    "Write <field> <comparison> <value>, with a field of {} ({}) and a comparison from: {}."
                                    .format(collector, ", ".join(fields), ", ".join(COMPARISONS))))
            continue
        field, comparison, raw = found.group(1), found.group(2), found.group(3).strip()
        value = _value(raw)
        kind = fields[field]
        if value is None:
            problems.append(problem("V6", where + " compares {} with '{}'.".format(field, raw),
                                    "A value is a number or one word of letters, digits, '_', '.' and '-' (up to 32)."))
        elif comparison in ORDERING and (isinstance(value, str) or kind == "code"):
            problems.append(problem("V6", where + " says '{}'.".format(text),
                                    "'{}' compares two numbers; use is or is not for a word.".format(comparison)))
        elif kind == "number" and isinstance(value, str):
            problems.append(problem("V6", where + " compares the number {} with the word '{}'.".format(field, raw),
                                    "{} is a number: write a number.".format(field)))
        else:
            checks.append({"field": field, "comparison": comparison, "value": value})
    if len(problems) != bad:
        return None
    return {"id": ident, "name": name, "collector": collector, "argument": argument, "checks": checks,
            "manual": False, "statement": ""}


def _manual(scenario: dict, name: str, ident: str, problems: List[dict]) -> Optional[dict]:
    steps = scenario["steps"]
    where = 'Scenario "{}"'.format(name)
    confirm = _CONFIRM.match(steps[0][1]) if len(steps) == 1 and steps[0][0] == "Then" else None
    if not confirm:
        problems.append(problem("V5", where + " is tagged @manual but is not one Then line.",
                                "A manual criterion is the one line 'Then Josh confirms that <statement>'."))
        return None
    return {"id": ident, "name": name, "collector": "", "argument": "", "checks": [], "manual": True,
            "statement": confirm.group(1).strip()}


def _criteria(block: str, problems: List[dict]) -> Tuple[List[dict], int]:
    """(the criteria that read cleanly, how many scenarios are measured)."""
    criteria: List[dict] = []
    measured = 0
    for number, scenario in enumerate(_read_scenarios(block), start=1):
        name = scenario["name"] or "scenario {}".format(number)
        if "@validate" not in scenario["tags"]:
            problems.append(problem("V4", 'Scenario "{}" has no @validate tag.'.format(name),
                                    "Tag every scenario in the Validation block @validate: a criterion nobody watches is worse than none."))
            continue
        manual = "@manual" in scenario["tags"]
        if not manual:
            measured += 1
        read = (_manual if manual else _measured)(scenario, name, "V{}".format(number), problems)
        if read:
            criteria.append(read)
    return criteria, measured


def _timetable(out: dict, values: Dict[str, str], problems: List[dict], key: str) -> None:
    """V3 for each field that is missing or not in its form; fills the section from the ones that read."""
    for name in ("starts", "check every", "complete when", "give up after", "fail after"):
        label = LABELS[name]
        value = values.get(name)
        if value is None:
            if name != "fail after":
                problems.append(problem("V3", "no {} line".format(label), FORMS[name]))
            continue
        read = None
        if name == "starts":
            read = read_starts(value)
            if read and read[0] == "ticket" and read[1] == key:
                read = None         # a ticket cannot wait for itself
            if read:
                out["starts"], out["starts_kind"] = value, read[0]
                out["starts_date"] = read[1] if read[0] == "date" else ""
                out["starts_ticket"] = read[1] if read[0] == "ticket" else ""
        elif name == "check every":
            read = out["check_every_hours"] = _read_every(value)
        elif name == "complete when":
            read = read_complete_when(value)
            if read:
                out["complete_when"], out["complete_kind"], out["complete_n"] = value, read[0], read[1]
        elif name == "give up after":
            read = out["give_up_days"] = _read_count(_GIVE_UP, value, 1, GIVE_UP_MAX)
        else:
            read = _read_count(_FAIL_AFTER, value, 1)
            if read is not None:
                out["fail_after"] = read
        if read is None:
            problems.append(problem("V3", "{}: '{}'".format(label, value), FORMS[name]))


def _room(out: dict, criteria: List[dict], problems: List[dict]) -> None:
    """V7: the timetable can finish."""
    if out["complete_kind"] == "streak" and out["check_every_hours"] and out["give_up_days"]:
        needed_hours = out["complete_n"] * out["check_every_hours"]
        if out["give_up_days"] * 24 < needed_hours:
            days = -(-needed_hours // 24)
            problems.append(problem("V7", "Give up after: {} days is shorter than {} checks every {} hours".format(
                out["give_up_days"], out["complete_n"], out["check_every_hours"]),
                "Give up after at least {} days, or ask for fewer checks.".format(days)))
    if out["complete_kind"] == "events":
        blind = sorted({c["collector"] for c in criteria if not c["manual"]
                        and not DECLARED[c["collector"]]["counts_events"]})
        if blind:
            problems.append(problem("V7", "'after {} events' with {}".format(out["complete_n"], ", ".join(blind)),
                                    "after <n> events needs collectors that count events ({}); use '<n> checks in a row pass'."
                                    .format(", ".join(k for k, v in DECLARED.items() if v["counts_events"]))))


def parse_text(body: Optional[str], key: str = "") -> dict:
    """The parsed section for a section's body alone. `None` is "no section": present is false and V1 is the problem."""
    if body is None:
        out = _empty(False)
        out["problems"].append(problem("V1", "no Validation section",
                                       "Add a Validation section: 'Needed: yes' with its timetable and criteria, or "
                                       "'Needed: no' and a reason."))
        return out
    out = _empty(True)
    out["section_version"] = _version(body)
    lines, block = split(body)
    values, twice, other = _fields(lines)
    problems: List[dict] = out["problems"]
    needed = values.get("needed", "")
    if "needed" in twice:
        problems.append(problem("V1", "Needed appears twice", "Keep one Needed line."))
    elif "needed" not in values:
        problems.append(problem("V1", "no Needed line", "Start with 'Needed: yes' or 'Needed: no' and a reason."))
    elif re.fullmatch(r"yes\.?", needed, re.IGNORECASE):
        out["needed"] = "yes"
    elif _NEEDED_NO.fullmatch(needed):
        out["needed"] = "no"
        out["reason"] = _NEEDED_NO.fullmatch(needed).group(1).strip()
    else:
        problems.append(problem("V1", "Needed: '{}'".format(needed), "Write 'Needed: yes' or 'Needed: no' and a reason."))
    if out["needed"] == "no":
        if len(out["reason"].split()) < MIN_REASON_WORDS:
            problems.append(problem("V2", "Needed: {}".format(needed),
                                    "Say in at least {} words why nothing needs watching.".format(MIN_REASON_WORDS)))
        elif len(values) > 1 or other or block.strip():
            problems.append(problem("V2", "Needed: no with other lines or scenarios",
                                    "Needed: no carries only its reason: remove the other lines and any scenario."))
    elif out["needed"] == "yes":
        for name in twice:
            problems.append(problem("V3", "{} appears twice".format(LABELS.get(name, name)),
                                    "Keep one {} line.".format(LABELS.get(name, name))))
        for line in other:
            problems.append(problem("V3", "the line '{}'".format(line), "Use only these fields: Needed, Starts, "
                                    "Check every, Complete when, Give up after and Fail after."))
        if not twice:
            _timetable(out, values, problems, key)
        criteria, measured = _criteria(block, problems)
        out["criteria"] = criteria
        if not _read_scenarios(block):
            problems.append(problem("V4", "no scenario", "Add at least one scenario tagged @validate in a gherkin block."))
        elif not measured and not any(p["item"] == "V4" for p in problems):
            problems.append(problem("V4", "only manual scenarios",
                                    "At least one criterion must be measured, with a When the watch reads line."))
        _room(out, criteria, problems)
    return out


def parse(description: Optional[str], key: str = "") -> dict:
    """The parsed Validation section of a ticket's description (marked text). With no section, `present` is false."""
    return parse_text(ticket_text.parse_sections(description).get(WHERE), key)


def route(section: dict) -> str:
    """not_needed: no section, or Needed: no. watch: Needed: yes and nothing wrong. unreadable: anything else."""
    if not section.get("present") or section.get("needed") == "no":
        return "not_needed"
    return "watch" if section.get("needed") == "yes" and not section.get("problems") else "unreadable"


def needs_watch(description: Optional[str]) -> bool:
    """True when the section is present and says Needed: yes, whatever else is wrong with it."""
    section = parse(description)
    return bool(section["present"]) and section["needed"] == "yes"
