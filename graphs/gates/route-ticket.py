#!/usr/bin/env python3
"""Routes a ticket to a space and a parent with the registry's written rules, with no model.

Inputs: GRAPH_INPUT_INTAKE_RECORD, GRAPH_INPUT_NAMED_SPACE, GRAPH_INPUT_NAMED_PARENT.
Outputs: route = {space, parent, area, priority, system, labels, rule}.
Outcomes: matched, unmatched, personal.
Rule: conventions/tickets.md, 'Routing a ticket to a space and a parent', through scripts/conventions.py. A space or
key Josh named wins; then the repository, then the folder. No match: space JP, no parent, outcome unmatched. A system
tracked in Linear: outcome personal. A repository the reader names that the registry does not list is no match: the
model never picks the system. TECH is never a ticket's space.

Built in JP-121 from the design in docs/design/ticket-creation-graph.md.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(ROOT / "scripts"))

import conventions  # noqa: E402
from lib.contracts import ContractError, load_record, value_of  # noqa: E402
from lib.gate_io import fail, finish, read_inputs  # noqa: E402

KEY = re.compile(r"^([A-Z][A-Z0-9]+)-[1-9][0-9]*$")


def named(value):
    text = (value or "").strip()
    return None if text.lower() in ("", "none", "null") else text


def route(record, named_space, named_parent, registry):
    spaces = set((registry.get("spaces") or {}).keys())
    named_space, named_parent = named(named_space), named(named_parent)
    named_space = named_space or named(record.get("named_space"))
    named_parent = named_parent or named(record.get("named_parent"))
    if named_parent and not KEY.match(named_parent):
        raise ValueError("a named parent must be a ticket key")
    if named_space and (named_space not in spaces or named_space == conventions.INITIATIVE_SPACE):
        raise ValueError(f"'{named_space}' is not a space a ticket can be created in")
    parent_space = KEY.match(named_parent).group(1) if named_parent else None
    if parent_space and named_space and parent_space != named_space:
        raise ValueError(f"{named_parent} is not in space {named_space}")
    if parent_space and parent_space not in spaces:
        raise ValueError(f"{named_parent} is not in a known space")

    repo = value_of(record.get("repository"))
    answer = None
    rule = "fallback"
    if isinstance(repo, str) and repo.strip():
        answer = conventions.lookup_repo(registry, repo)
        rule = "repository"
    if (answer is None or answer["unassigned"]) and isinstance(record.get("folder"), str) and record["folder"].strip():
        answer = conventions.lookup_folder(registry, record["folder"])
        rule = "folder"
    if answer is None or answer["unassigned"]:
        answer, rule = None, "fallback"
    if answer is not None and answer["tracker"] == "linear":
        return "personal", {"space": None, "parent": None, "area": None, "priority": answer["priority"],
                            "system": answer["system"], "labels": [], "rule": rule}
    fallback_space = (registry.get("fallback") or {}).get("jira_space") or "JP"
    space = named_space or parent_space or (answer["jira_space"] if answer else fallback_space)
    system_space = answer["jira_space"] if answer else None
    parent = named_parent or (answer["default_epic"] if answer and system_space == space else None)
    result = {"space": space, "parent": parent, "area": answer["area"] if answer else None,
              "priority": answer["priority"] if answer else (registry.get("fallback") or {}).get("priority"),
              "system": answer["system"] if answer else None,
              "labels": [answer["system"]] if answer and answer["system"] else [],
              "rule": "named" if (named_space or named_parent) else rule}
    has_home = bool(parent or result["area"])
    return ("matched" if has_home else "unmatched"), result


if __name__ == "__main__":
    values = read_inputs(["intake_record", "named_space", "named_parent"])
    try:
        record = load_record(values["intake_record"])
        registry = json.loads((ROOT / "conventions" / "registry.json").read_text(encoding="utf-8"))
        outcome, result = route(record, values["named_space"], values["named_parent"], registry)
    except (ContractError, ValueError, OSError) as err:
        fail(f"route-ticket: {err}")
    finish(outcome, {"route": result}, f"{outcome}: {result['space']} by {result['rule']}")
