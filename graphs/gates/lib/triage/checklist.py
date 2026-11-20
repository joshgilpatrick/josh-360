"""The Ready checklist (JP-122): C1 to C13 for every type, then B1 and B2 (Bug), S1 (Story), R1 and R2 (Research) and
V1 to V7 (the Validation section of a Story, Task or Bug; JP-165, `lib/triage/validation_items.py`).

Python 3.9, standard library only. This is now the source of the list; the spec's "The Ready checklist" table says what
each item means, and graphs/contracts/ready-checklist.md says what a failure holds. Required sections and their order
come from `lib/ready_checklist.CHECKLIST` (ticket creation's table, from conventions/tickets.md, "Required sections"),
so the two graphs cannot disagree about what a ticket is made of.

`run_checklist(ticket, context)` returns a list of failures (dicts of `item`, `where`, `found`, `needed`); an empty
list is a pass. It never raises for a malformed ticket: a section it cannot read is reported missing. It raises
`Unknown` when a fact it needs is unknown (Jira could not say whether a linked ticket exists), because unknown is
never read as "passes" or as "fails".

No patient data in any failure. A C13 failure names the item and the section and the kind of match, never the text.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional, Set

from lib import patient_data, ready_checklist
from lib.ticket_text import collapse
from lib.triage import RUN_LABEL, TRIAGE_TYPES
from lib.triage.gherkin import find_gherkin_blocks, read_feature, strip_blocks
from lib.triage.registry import RepoLookup
from lib.triage.ticket import Ticket
from lib.triage.validation_items import check_validation

TEST_TAGS = ("@auto", "@e2e", "@manual")
PLACEHOLDERS = {"tbd", "todo", "?", "...", "…", "n/a", "na", "fill in", "fill this in", "to be decided", "to be determined"}
MAY_SAY_NONE = ("Not in scope", "Decisions already made", "Repository")   # Repository: C7 and S1/B2 rule on none
KEY = re.compile(r"\b[A-Z][A-Z0-9]+-[1-9][0-9]*\b")
PARENT = re.compile(r"\bParent\s*:\s*([A-Z][A-Z0-9]+-[1-9][0-9]*)")
MARKERS = re.compile(r"\b(?:TBD|TODO)\b|\?\?\?|to be decided|ask josh", re.IGNORECASE)
BUG_LINES = ("Steps to reproduce", "Expected", "Actual", "Environment", "Affected system")
# A section the checklist reports under its own item instead of C2 or C3.
OWN_ITEM = {("Bug", "Current behaviour"): "B1", ("Research", "Question"): "R1", ("Research", "Sources"): "R1",
            ("Research", "Deliverable format"): "R1"}


class Unknown(Exception):
    """A fact the checklist needs could not be read. The gate stops the run; it does not guess."""


@dataclass
class Context:
    """What the checklist needs from outside the ticket. Tests pass plain values and functions."""
    lookup: RepoLookup                                   # repository -> {"system", "space"} or None
    system_names: Set[str]
    key_exists: Callable[[str], Optional[bool]]          # True, False, or None for unknown
    send_back_after_edit: bool = False                   # a Triage send-back comment is newer than the last edit


def failure(item: str, where: str, found: str, needed: str) -> Dict[str, str]:
    found = collapse(found)
    if len(found) > 200:
        found = found[:199] + "…"
    return {"item": item, "where": where, "found": found or "missing", "needed": needed}


def required_labels(ticket_type: str) -> List[str]:
    """The sections a ticket of this type needs, in order: Repository and Where it runs follow the acceptance
    criteria, or the Validation section that follows them, as they do in the ticket format."""
    checks = ready_checklist.CHECKLIST.get(ticket_type, [])
    last = "validation" if any(c["section"] == "validation" for c in checks) else "acceptance_criteria"
    labels: List[str] = []
    for check in checks:
        labels.append(check["label"])
        if check["section"] == last:
            labels += ["Repository", "Where it runs"]
    return labels


def _lines(text: str) -> List[str]:
    out = []
    for line in (text or "").split("\n"):
        line = re.sub(r"^\s*(?:[-*•]|\d+[.)])\s*", "", line).strip()
        if line:
            out.append(line)
    return out


def is_placeholder(text: str) -> bool:
    return all(line.strip(" .:;()[]").lower() in PLACEHOLDERS or line.strip().lower() in PLACEHOLDERS
               for line in _lines(text)) and bool(_lines(text))


def _says_none(text: str) -> bool:
    return [line.strip(" .").lower() for line in _lines(text)] == ["none"]


def _item_for(ticket: Ticket, label: str, default: str) -> str:
    return OWN_ITEM.get((ticket.type, label), default)


def check_sections(ticket: Ticket, labels: List[str]) -> List[dict]:
    """C2 (present once, in order) and C3 (not empty, not a placeholder)."""
    out: List[dict] = []
    for label in labels:
        n = ticket.count(label)
        if n == 0 and label == "Validation":
            continue            # V1 reports a missing Validation section, with what to write
        if n == 0:
            out.append(failure(_item_for(ticket, label, "C2"), label, "missing",
                               "Add a bold {} section.".format(label)))
        elif n > 1:
            out.append(failure("C2", label, "appears {} times".format(n), "Keep one {} section.".format(label)))
    present = [label for label in labels if ticket.count(label) == 1]
    order = [name for name, _ in ticket.sections if name in present]
    seen: List[str] = []
    for name in order:
        if name not in seen:
            seen.append(name)
    if seen != present:
        out.append(failure("C2", "ticket", "sections read in this order: " + ", ".join(seen),
                           "Put the sections in this order: " + ", ".join(present) + "."))
    for label in present:
        text = ticket.section(label) or ""
        item = _item_for(ticket, label, "C3")
        if label == "Validation":
            continue            # V1 to V7 own what the section says
        if label == "Acceptance criteria":
            if not text.strip():
                out.append(failure(item, label, "empty", "Say what is true when the work is done."))
            continue
        if not _lines(text):
            out.append(failure(item, label, "empty", "Fill in {}.".format(label)))
        elif is_placeholder(text) and not (label in MAY_SAY_NONE and _says_none(text)):
            out.append(failure(item, label, text, "Replace the placeholder with the real text."))
        elif _says_none(text) and label not in MAY_SAY_NONE:
            out.append(failure(item, label, text, "Fill in {}; only Not in scope, Decisions already made and Repository may say None."
                               .format(label)))
    return out


def check_gherkin_text(text: str, where: str, item_prefix: str = "") -> List[dict]:
    """C4, C5 and C6 for one section's Gherkin."""
    out: List[dict] = []
    blocks = find_gherkin_blocks(text)
    if len(blocks) != 1:
        found = "no gherkin block" if not blocks else "{} gherkin blocks".format(len(blocks))
        return [failure("C4", where, found, "Hold exactly one gherkin code block.")]
    has_feature, scenarios = read_feature(blocks[0])
    if not has_feature:
        out.append(failure("C4", where, "no Feature line", "Start the block with a Feature line."))
    if not scenarios:
        out.append(failure("C4", where, "no Scenario", "Add at least one Scenario."))
    for s in scenarios:
        label = 'Scenario "{}"'.format(s.name)
        if s.givens < 1:
            out.append(failure("C5", where, label + " has no Given.", "Give every scenario at least one Given."))
        if s.whens > 1:
            out.append(failure("C5", where, label + " has {} When lines.".format(s.whens),
                               "One action per scenario: one When."))
        if s.thens < 1:
            out.append(failure("C5", where, label + " has no Then.", "Give every scenario at least one Then."))
        tags = [t for t in s.tags if t in TEST_TAGS]
        if len(tags) != 1:
            found = label + (" has no test tag." if not tags else " has {} test tags.".format(len(tags)))
            out.append(failure("C6", where, found, "Exactly one of @auto, @e2e or @manual."))
    return out


def repository_of(ticket: Ticket) -> Optional[str]:
    text = ticket.section("Repository")
    if text is None or not text.strip():
        return None
    first = _lines(text)[0].split()[0] if _lines(text) else ""
    return first.strip("`*_.,;:()") or None


def checkrepository_of(ticket: Ticket, ctx: Context) -> List[dict]:
    """C7 and C8, plus S1 and B2 (a Story or a Bug has a repository)."""
    out: List[dict] = []
    repo = repository_of(ticket)
    if repo is None:
        return out          # C2 or C3 already says it is missing or empty
    none = repo.lower() == "none"
    if none and ticket.type == "Story":
        out.append(failure("S1", "Repository", "none", "A Story changes a repository: name it."))
    elif none and ticket.type == "Bug":
        out.append(failure("B2", "Repository", "none", "A Bug is in a repository: name it."))
    elif not none:
        answer = ctx.lookup(repo)
        if answer is None:
            out.append(failure("C7", "Repository", repo, "Name a repository the registry lists, or none (Task or "
                               "Research only)."))
        elif answer["system"] not in ticket.labels:
            out.append(failure("C8", "labels", "labels: " + (", ".join(ticket.labels) or "none"),
                               "Add the label {}.".format(answer["system"])))
    for label in ticket.labels:   # ready-to-run is the runner's start label (JP-117), so it is never a gap (JP-188)
        if label not in ("improvement", RUN_LABEL) and label not in ctx.system_names:
            out.append(failure("C8", "labels", label, "Labels are a registry system name, improvement or "
                                                      "ready-to-run."))
    return out


def check_where_it_runs(ticket: Ticket) -> List[dict]:
    text = ticket.section("Where it runs")
    if text is None or not _lines(text):
        return []
    line = collapse(text)
    lowered = line.lower()
    for prefix in ("cloud session", "josh's laptop", "josh’s laptop"):
        if lowered.startswith(prefix):
            rest = line[len(prefix):].strip(" .:;,-–—")
            if prefix != "cloud session" and len(rest.split()) < 2:
                return [failure("C9", "Where it runs", line, "Say why it must run on Josh's laptop.")]
            return []
    return [failure("C9", "Where it runs", line, "Start with Cloud session or Josh's laptop.")]


def check_links(ticket: Ticket, ctx: Context) -> List[dict]:
    """C10: every ticket key under Parent or related exists, and the parent is in this ticket's space."""
    text = ticket.section("Parent or related")
    if not text:
        return []
    out: List[dict] = []
    for key in dict.fromkeys(KEY.findall(text)):
        if key == ticket.key:
            continue
        exists = ctx.key_exists(key)
        if exists is None:
            raise Unknown("whether {} exists".format(key))
        if not exists:
            out.append(failure("C10", "Parent or related", key, "{} does not exist: fix the key.".format(key)))
    parent = PARENT.search(text)
    if parent and parent.group(1).rsplit("-", 1)[0] != ticket.space:
        out.append(failure("C10", "Parent or related", parent.group(1),
                           "A parent is in the same Jira space ({}); link the other space with Relates.".format(ticket.space)))
    return out


def check_subtasks(ticket: Ticket) -> List[dict]:
    """C11: every subtask has a Goal and a Done when that passes C4 to C6; the parent passes only when they all do."""
    out: List[dict] = []
    for sub in ticket.subtasks:
        where = "Subtask " + sub.key
        goal = sub.section("Goal")
        if goal is None or not _lines(goal):
            out.append(failure("C11", where, "no Goal", "Give the subtask a Goal."))
        done = sub.section("Done when")
        if done is None or not _lines(done):
            out.append(failure("C11", where, "no Done when", "Give the subtask a Done when in Gherkin."))
        else:
            for f in check_gherkin_text(done, where):
                out.append(failure("C11", where, "{} {}".format(f["item"], f["found"]), f["needed"]))
    return out


def _unquoted(text: str) -> str:
    text = re.sub(r"\"[^\"\n]*\"|“[^”\n]*”|‘[^’\n]*’|`[^`\n]*`", " ", text)
    return text


def check_open_questions(ticket: Ticket, ctx: Context) -> List[dict]:
    """C12 (every type but Research; R2 says it does not apply to Research)."""
    out: List[dict] = []
    for label, text in ticket.sections:
        if label == "Open questions":
            for line in (text or "").split("\n"):
                bullet = re.match(r"^\s*(?:[-*•]|\d+[.)])\s*(.*)$", line)
                if bullet and bullet.group(1).strip() and not bullet.group(1).strip().lower().startswith("answered:"):
                    out.append(failure("C12", "Open questions", bullet.group(1),
                                       "Answer it (start the line Answered:) or remove it; Ready has no open question."))
        body = strip_blocks(text) if label in ("Acceptance criteria", "Validation") else text
        for line in _unquoted(body).split("\n"):
            stripped = line.strip()
            if label != "Open questions" and stripped.endswith("?"):
                out.append(failure("C12", label, line.strip(), "State the answer, not a question."))
            marker = MARKERS.search(stripped)
            if marker and label != "Acceptance criteria":
                out.append(failure("C12", label, marker.group(0), "Replace the marker with the decision."))
    if ticket.flagged:
        out.append(failure("C12", "ticket", "the Flagged field is on", "Clear the flag once the question is answered."))
    if ctx.send_back_after_edit:
        out.append(failure("C12", "ticket", "a send-back comment is newer than the last edit",
                           "Edit the ticket to close the gaps the comment lists."))
    return out


def check_patient_data(ticket: Ticket) -> List[dict]:
    """C13: the shared screen for text written to Jira. A failure names the section and the kind, never the text."""
    out: List[dict] = []
    for label, text in [("Summary", ticket.summary)] + list(ticket.sections):
        kinds = patient_data.scan(text or "", None, False, external=True)
        if kinds:
            out.append({"item": "C13", "where": label, "found": "missing",
                        "needed": "Remove the patient identifier ({}); refer to a file by its path only."
                        .format(", ".join(kinds))})
    return out


def check_bug(ticket: Ticket) -> List[dict]:
    text = ticket.section("Current behaviour")
    if not text or not _lines(text):
        return []
    out: List[dict] = []
    for name in BUG_LINES:
        pattern = re.compile(r"^\s*(?:[-*•]\s*)?\**\s*" + re.escape(name) + r"\**\s*:\s*\**\s*(.*)$", re.IGNORECASE)
        values = [m.group(1).strip() for m in (pattern.match(line) for line in text.split("\n")) if m]
        if not values:
            out.append(failure("B1", "Current behaviour", "no {} line".format(name),
                               "Add a line that starts {}:.".format(name)))
        elif not any(values):
            out.append(failure("B1", "Current behaviour", "{} is empty".format(name), "Fill in {}.".format(name)))
    return out


def run_checklist(ticket: Ticket, ctx: Context) -> List[dict]:
    if ticket.type not in TRIAGE_TYPES:
        return [failure("C1", "ticket", ticket.type or "no type",
                        "The type is Story, Task, Bug or Research ({} never enters triage).".format(ticket.type or "this"))]
    labels = required_labels(ticket.type)
    out = check_sections(ticket, labels)
    acceptance = ticket.section("Acceptance criteria")
    if acceptance is not None and acceptance.strip():
        out += check_gherkin_text(acceptance, "Acceptance criteria")
    out += check_validation(ticket)
    out += checkrepository_of(ticket, ctx)
    out += check_where_it_runs(ticket)
    out += check_links(ticket, ctx)
    out += check_subtasks(ticket)
    if ticket.type != "Research":
        out += check_open_questions(ticket, ctx)
    out += check_patient_data(ticket)
    if ticket.type == "Bug":
        out += check_bug(ticket)
    return out
