#!/usr/bin/env python3
"""The per-ticket decision files (JP-153): docs/decisions/JP-<n>.md, one table of default choices each.

  python3 scripts/decisions.py list [--ticket JP-n]   print every row (or one ticket's rows)
  python3 scripts/decisions.py check                  exit 1 and say where each problem is

Every pull request writes only its own ticket's file, so two PRs never edit the same lines. This file and
docs/decisions.md's old table are read by nothing else; the rows below are the record of build-time choices.
Standard library only.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FOLDER = ROOT / "docs" / "decisions"
OLD_FILE = ROOT / "docs" / "decisions.md"
HEADER = ["Date", "Ticket", "Question", "Option taken", "How to undo"]
NAME_RE = re.compile(r"^JP-\d+\.md$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
CELL_SPLIT = re.compile(r"(?<!\\)\|")


def cells(line: str) -> list[str]:
    """A table row's cells. A pipe inside a cell is written \\| and does not split."""
    return [c.strip() for c in CELL_SPLIT.split(line.strip())[1:-1]]


def rows_of(path: Path) -> tuple[list[tuple[int, list[str]]], list[str]]:
    """(line number, cells) for each data row, and the problems found in the file's shape."""
    problems: list[str] = []
    rel = path.relative_to(ROOT)
    lines = path.read_text(encoding="utf-8").splitlines()
    ticket = path.stem
    if not lines or lines[0] != "# {} decisions".format(ticket):
        problems.append("{}:1: the first line must be '# {} decisions'".format(rel, ticket))
    table = [(n, l) for n, l in enumerate(lines, 1) if l.startswith("|")]
    if len(table) < 2 or cells(table[0][1]) != HEADER or set("".join(cells(table[1][1]))) - set("-: "):
        problems.append("{}: the table must start with the header '| {} |' and a separator row".format(rel, " | ".join(HEADER)))
        return [], problems
    out = []
    for n, line in table[2:]:
        cs = cells(line)
        if len(cs) != 5 or not all(cs):
            problems.append("{}:{}: a row needs five filled cells ({}); write a pipe inside a cell as \\|".format(rel, n, ", ".join(HEADER)))
            continue
        if not DATE_RE.match(cs[0]):
            problems.append("{}:{}: the date must be YYYY-MM-DD, not {!r}".format(rel, n, cs[0]))
        if cs[1] != ticket:
            problems.append("{}:{}: the row is for {} but this file is {}'s; move it to docs/decisions/{}.md".format(rel, n, cs[1], ticket, cs[1]))
        out.append((n, cs))
    if not out:
        problems.append("{}: the table has no rows".format(rel))
    return out, problems


def files() -> list[Path]:
    return sorted((p for p in FOLDER.glob("*.md") if p.name != "README.md"), key=lambda p: (len(p.stem), p.stem))


def check() -> list[str]:
    problems: list[str] = []
    if not (FOLDER / "README.md").is_file():
        problems.append("docs/decisions/README.md is missing")
    for path in sorted(FOLDER.glob("*.md")) if FOLDER.is_dir() else []:
        if path.name == "README.md":
            continue
        if not NAME_RE.match(path.name):
            problems.append("docs/decisions/{}: name the file after its ticket, JP-<n>.md".format(path.name))
            continue
        problems.extend(rows_of(path)[1])
    # Rows left in the old shared table: the usual leftover after merging main into an older branch.
    # Only the "Default choices" section: Josh's recorded decisions above it are rows of other kinds.
    old = OLD_FILE.read_text(encoding="utf-8").splitlines() if OLD_FILE.is_file() else []
    start = next((i for i, l in enumerate(old) if l.startswith("## Default choices made while building")), len(old))
    for n, line in enumerate(old, 1):
        if n > start and re.match(r"^\|\s*\d{4}-\d{2}-\d{2}\s*\|\s*JP-\d+\s*\|", line):
            ticket = cells(line)[1]
            problems.append("docs/decisions.md:{}: a default-choice row for {}; move it to docs/decisions/{}.md".format(n, ticket, ticket))
    return problems


def main(argv: list[str]) -> int:
    cmd = argv[0] if argv else ""
    if cmd == "check":
        problems = check()
        for p in problems:
            print(p)
        print("decisions: {}".format("ok" if not problems else "{} problem(s)".format(len(problems))))
        return 1 if problems else 0
    if cmd == "list":
        only = argv[argv.index("--ticket") + 1] if "--ticket" in argv and argv.index("--ticket") + 1 < len(argv) else None
        for path in files():
            if only and path.stem != only:
                continue
            for _, cs in rows_of(path)[0]:
                print(" | ".join(cs))
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
