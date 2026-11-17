"""The feedback file's text, one writer for every gate that keeps defects (JP-123, JP-115).

Python 3.9, standard library only. A feedback file (contract `feedback`) is a title, a line of introduction and a block
between two `---` lines: `[]` when nothing was kept, else one entry per defect with its fields in a fixed order and
every value as a JSON string. `check-review` (JP-123) wrote this block first; the development graph's gates share it.
"""
from __future__ import annotations

import json
from typing import List, Sequence


def feedback_text(title: str, intro: str, rows: List[dict], fields: Sequence[str]) -> str:
    """The whole file. `title` is the heading without its `# `; each row is written with `fields`, in that order."""
    lines = ["# {}".format(title), "", intro, "", "---"]
    if not rows:
        lines.append("[]")
    for row in rows:
        first = True
        for field in fields:
            lines.append("{}{}: {}".format("- " if first else "  ", field, json.dumps(str(row.get(field, "")))))
            first = False
    lines.append("---")
    return "\n".join(lines) + "\n"
