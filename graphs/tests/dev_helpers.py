"""Made-up specs, tickets and (from Task 7) scratch repositories and fakes for the development gates' tests (JP-115).

Nothing here is real data, and nothing reaches Jira, GitHub or the network. Python 3.9, standard library only.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Optional

from nondev_helpers import Case, FakeTicket, gate, make_deps  # noqa: F401  (re-exported for the dev tests)

KEY = "JP-9002"

DESCRIPTION = """**Goal:** Label the widget.

**Acceptance criteria:**

```gherkin
Feature: The widget label

  @auto
  Scenario: A widget is labelled
    Given a widget
    When it is built
    Then it carries a label

  @manual
  Scenario: The label reads well on a real screen
    Given a widget on a real screen
    Then a person can read it
```

**Repository:** widgets

**Open questions:**

- Answered: which colour? Blue.
"""

SPEC = {
    "ticket": KEY,
    "summary": "Adds a label to the widget and checks it reads back.",
    "definition_of_done": [
        {"id": "DOD-1", "rule": "No placeholders: no TODO, FIXME or stub bodies in files this plan changed."},
        {"id": "DOD-2", "rule": "Every item in a phase's task list is implemented in full."},
        {"id": "DOD-3", "rule": "Tests assert the behaviour the phase names."},
        {"id": "DOD-4", "rule": "Every check of every phase ran and passed on the final tree."},
        {"id": "DOD-5", "rule": "Files changed are the files the phases name."},
    ],
    "phases": [
        {"id": "p1", "title": "The widget file", "task": ["Create widget.txt", "Put the word widget in it"],
         "checks": ["test -f widget.txt"], "files": ["widget.txt"]},
        {"id": "p2", "title": "The label", "task": ["Add the label line to widget.txt"],
         "checks": ["grep -q label widget.txt"], "files": ["widget.txt", "README.md"]},
    ],
    "scenarios": [
        {"name": "A widget is labelled", "tag": "@auto", "proved_by": "p2.check.1"},
        {"name": "The label reads well on a real screen", "tag": "@manual", "proved_by": "docs/proof/widget/README.md"},
    ],
}


def spec_copy(**changes) -> dict:
    """A deep copy of SPEC with top-level fields replaced."""
    spec = copy.deepcopy(SPEC)
    spec.update(changes)
    return spec


def write_spec(work_dir: Path, spec: Optional[dict] = None) -> Path:
    """Write the spec in YAML's JSON form to <work_dir>/spec.yaml and return the path."""
    work_dir.mkdir(parents=True, exist_ok=True)
    path = work_dir / "spec.yaml"
    path.write_text(json.dumps(SPEC if spec is None else spec, indent=1), encoding="utf-8")
    return path
