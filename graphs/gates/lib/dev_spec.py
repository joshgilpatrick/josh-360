"""Reading a build spec, checking its shape, and the phase state file (JP-115; contract `spec`).

Python 3.9, standard library only. The spec is written in YAML's JSON form (every JSON document is valid YAML),
because the laptop's Python has no YAML reader: `load` reads it with `json` and refuses anything else, so a spec
written as block YAML is a refusal that says so, never a half-read file.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import List, Optional

from lib.ticket_text import collapse, without_section

PHASE_ID = re.compile(r"^[a-z][a-z0-9-]*$")
DOD_ID = re.compile(r"^DOD-[0-9]+$")
TAGS = ("@auto", "@e2e", "@manual")
_SCENARIO = re.compile(r"^\s*Scenario(?: Outline)?:\s*(.+?)\s*$", re.MULTILINE)
_PHASE_ITEM = re.compile(r"^([a-z][a-z0-9-]*)\.(task|check)\.([1-9][0-9]*)$")


class SpecError(Exception):
    """The spec or the state file cannot be read. The message never quotes the file."""


def load(path: Path) -> dict:
    try:
        doc = json.loads(Path(path).read_text(encoding="utf-8"))
    except OSError:
        raise SpecError("the spec file could not be read")
    except ValueError:
        raise SpecError("the spec is not in YAML's JSON form (one JSON object)")
    if not isinstance(doc, dict):
        raise SpecError("the spec must be one JSON object")
    return doc


def scenario_names(description: Optional[str]) -> List[str]:
    """Every `Scenario:` or `Scenario Outline:` line of a ticket, whitespace collapsed. The Validation section's
    scenarios are watched after the ticket ships and are not acceptance scenarios: they are left out."""
    return [collapse(name) for name in _SCENARIO.findall(without_section(description, "Validation"))]


def _norm(text: object) -> str:
    return collapse(text if isinstance(text, str) else "").casefold()


def _text(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _strings(value: object) -> bool:
    return isinstance(value, list) and bool(value) and all(_text(v) for v in value)


def criterion_text(spec: dict, criterion: object) -> Optional[str]:
    """The text of `DOD-<n>`, `<phase>.task.<n>` or `<phase>.check.<n>` (1-based), or None when there is no such one."""
    if not isinstance(criterion, str):
        return None
    wanted = criterion.strip()
    if DOD_ID.match(wanted):
        for item in spec.get("definition_of_done") or []:
            if isinstance(item, dict) and item.get("id") == wanted and _text(item.get("rule")):
                return item["rule"]
        return None
    found = _PHASE_ITEM.match(wanted)
    if not found:
        return None
    phase_id, kind, number = found.group(1), found.group(2), int(found.group(3))
    for phase in spec.get("phases") or []:
        if isinstance(phase, dict) and phase.get("id") == phase_id:
            items = phase.get("task" if kind == "task" else "checks")
            if isinstance(items, list) and number <= len(items) and _text(items[number - 1]):
                return items[number - 1]
    return None


def spec_text(spec: dict) -> str:
    """Every string value of the spec, one per line: what a quoted finding is matched against."""
    found: List[str] = []

    def walk(node: object) -> None:
        if isinstance(node, str):
            found.append(node)
        elif isinstance(node, dict):
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(spec)
    return "\n".join(found)


def problems(spec: dict, ticket_scenarios: List[str]) -> List[str]:
    """What is wrong with the spec's shape, one sentence each; empty when it is complete."""
    out: List[str] = []
    for field in ("ticket", "summary"):
        if not _text(spec.get(field)):
            out.append("the spec has no {}".format(field))
    dod = [i for i in (spec.get("definition_of_done") or []) if isinstance(i, dict)] \
        if isinstance(spec.get("definition_of_done"), list) else []
    if not any(DOD_ID.match(str(i.get("id", ""))) and _text(i.get("rule")) for i in dod):
        out.append("definition_of_done needs at least one item with an id like DOD-1 and a rule")
    phases = spec.get("phases") if isinstance(spec.get("phases"), list) else []
    if not phases:
        out.append("the spec has no phase")
    seen = set()
    for index, phase in enumerate(phases):
        if not isinstance(phase, dict):
            out.append("phase {} is not an object".format(index + 1))
            continue
        pid = phase.get("id")
        label = pid if isinstance(pid, str) and pid else "number {}".format(index + 1)
        if not isinstance(pid, str) or not PHASE_ID.match(pid):
            out.append("the id of phase {} must be lower case words joined by hyphens, starting with a letter".format(label))
        elif pid in seen:
            out.append("the phase id '{}' is used more than once".format(pid))
        seen.add(pid)
        if not _strings(phase.get("task")):
            out.append("phase {} has no task items".format(label))
        if not _strings(phase.get("checks")):
            out.append("phase {} has no checks".format(label))
        if not isinstance(phase.get("files"), list):
            out.append("phase {} has no files list".format(label))
    rows = [r for r in (spec.get("scenarios") or []) if isinstance(r, dict)] \
        if isinstance(spec.get("scenarios"), list) else []
    named = {_norm(r.get("name")) for r in rows}
    for name in ticket_scenarios:
        if _norm(name) not in named:
            out.append("the ticket's scenario '{}' is not in scenarios".format(name))
    for row in rows:
        name = row.get("name") if _text(row.get("name")) else "(no name)"
        tag, proof = row.get("tag"), row.get("proved_by")
        if tag not in TAGS:
            out.append("scenario '{}' has the tag {!r}, which is not @auto, @e2e or @manual".format(name, tag))
        if not _text(proof):
            out.append("scenario '{}' has an empty proved_by".format(name))
        elif tag == "@auto":
            found = _PHASE_ITEM.match(proof.strip())
            if not found or found.group(2) != "check" or criterion_text(spec, proof) is None:
                out.append("the @auto scenario '{}' must name a phase check in proved_by, such as p1.check.1".format(name))
    return out


def _empty_state() -> dict:
    return {"review_round": 0, "phases": {}}


def load_state(work_dir: Path) -> dict:
    """`state.json` in the work folder; a missing file is the empty state, an unreadable one is a SpecError."""
    path = Path(work_dir) / "state.json"
    if not path.exists():
        return _empty_state()
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise SpecError("state.json could not be read")
    if not isinstance(doc, dict) or not isinstance(doc.get("phases", {}), dict):
        raise SpecError("state.json is not the phase state")
    doc.setdefault("review_round", 0)
    doc.setdefault("phases", {})
    return doc


def save_state(work_dir: Path, state: dict) -> None:
    path = Path(work_dir) / "state.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(state, indent=1, sort_keys=True), encoding="utf-8")
    os.replace(str(tmp), str(path))
