"""Shared helpers for the ticket creation gate tests (JP-121). Every record, proposal and text here is made up."""
from __future__ import annotations

import copy
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
GATES = ROOT / "graphs" / "gates"
sys.path.insert(0, str(GATES))

SOURCE_TEXT = "Please add a dry-run flag to the laptop install script so I can preview an install before it runs."

RECORD = {
    "source": "todo", "source_ref": "todo-0007", "requester": "Josh",
    "request": "Add a dry-run flag to the laptop install script so a change can be previewed.",
    "deliverable": {"value": "a merged pull request in josh-360", "basis": "inferred"},
    "ticket_type": "Story", "work_kind": "code", "weight": "light",
    "repository": {"value": "josh-360", "basis": "stated"},
    "search_terms": ["dry run", "install preview", "install.py flag"], "unresolved": [],
    "contains_patient_data": False,
}

GHERKIN = ("Feature: Install dry run\n  @auto\n  Scenario: Nothing changes\n    Given a laptop copy at the last good "
           "commit\n    When install.py runs with --dry-run\n    Then it lists each step and the copy is unchanged")


NO_VALIDATION = "- Needed: no. The change is a document; nothing runs."


def section_set(**over):
    sections = {"goal": "laptop/install.py --dry-run prints every step it would take and changes nothing.",
                "first_step": "Read STEPS in laptop/install.py.",
                "why": "Josh wants to preview an install before it runs.",
                "in_scope": ["A --dry-run flag on laptop/install.py"], "not_in_scope": ["Changing what an install does"],
                "acceptance_criteria": GHERKIN, "validation": NO_VALIDATION, "parent_or_related": "Parent: JP-94", "decisions_already_made": []}
    sections.update(over)
    return sections


def ticket(ref="t1", **over):
    base = {"ref": ref, "type": "Story", "summary": "Add a dry-run flag to the laptop install script",
            "work_kind": "code", "repository": "josh-360", "where_it_runs": "Cloud session", "sections": section_set()}
    base.update(over)
    return base


def proposal(**over):
    base = {"action": "create", "shape": "single",
            "route": {"space": "JP", "parent": "JP-94", "area": None, "system": "josh-360", "priority": "devex",
                      "labels": ["josh-360"], "rule": "repository"},
            "tickets": [ticket()], "inferred": ["t1.first_step", "t1.where_it_runs"], "gaps": [],
            "authors": ["session-a", "session-b"]}
    base.update(over)
    return base


def family():
    """An epic with three tickets, the second blocked by the first and the third by the second."""
    epic = ticket("t1", type="Epic", summary="Move the survey export to the new pipeline", work_kind="code",
                  sections={"goal": "The survey export runs on the new pipeline.", "phases": ["Build", "Backfill", "Switch"],
                            "done_when": "the old export job is off", "related_work": [],
                            "branch_strategy": "one branch per ticket"})
    kids = [ticket("t2", type="Task", summary="Build the new export step", delivers="the export"),
            ticket("t3", type="Task", summary="Backfill the last 90 days", delivers="the history",
                   links=[{"kind": "blocked_by", "target": "t2"}]),
            ticket("t4", type="Task", summary="Switch off the old job", delivers="the switch-off",
                   links=[{"kind": "blocked_by", "target": "t3"}])]
    return proposal(shape="epic_with_tickets", tickets=[epic] + kids,
                    route={"space": "AD", "parent": None, "area": "Clinical application platform",
                           "system": "survey-services", "labels": ["survey-services"], "rule": "repository"},
                    inferred=["t1.done_when", "t1.branch_strategy"])


def load_gate(name):
    """A gate script as a module (its name has dashes), without running its main block."""
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), GATES / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_gate(name, tmp, inputs, extra_env=None):
    """Run a gate script as the walker does. Returns (exit code, parsed JSON line or None, stderr)."""
    env = {k: v for k, v in os.environ.items() if not k.startswith(("GRAPH_INPUT_", "JOSH360_", "DESK_"))}
    env.update({"JOSH360_ACTION_ITEMS": str(Path(tmp) / "action-items.json"), "JOSH360_RUNS": str(Path(tmp) / "runs"),
                "DESK_DB": str(Path(tmp) / "desk.db")})
    for key, value in inputs.items():
        env["GRAPH_INPUT_" + key.upper()] = value if isinstance(value, str) else json.dumps(value)
    env.update(extra_env or {})
    done = subprocess.run([sys.executable, str(GATES / f"{name}.py")], env=env, cwd=str(tmp), capture_output=True,
                          text=True)
    lines = [ln for ln in done.stdout.splitlines() if ln.strip()]
    return done.returncode, (json.loads(lines[-1]) if lines else None), done.stderr


def write_json(path, value):
    Path(path).write_text(json.dumps(value), encoding="utf-8")
    return str(path)


def action_items(tmp, *todos):
    write_json(Path(tmp) / "action-items.json", {"items": {}, "todos": list(todos)})


def todo(item_id="todo-0007", text=SOURCE_TEXT, **over):
    base = {"id": item_id, "text": text, "owner": None, "deadline": None, "priority": "medium", "status": "active",
            "taskId": None, "meetingId": "__todo__"}
    base.update(over)
    return base


def clone(value):
    return copy.deepcopy(value)
