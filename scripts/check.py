#!/usr/bin/env python3
"""josh-360 repo checks, run locally before every push and by CI as the `suite` job.

Checks:
  1. The workflow files exist.
  2. No workflow file still holds an unfilled bootstrap value ("{{NAME}}"). GitHub's own "${{ ... }}"
     expressions in workflow YAML are allowed.
  3. Every skill has frontmatter whose name matches its folder and which has a description; every command
     and subagent has a description; a frontmatter value holding ": " is quoted.
  4. Every "](#anchor)" link in a Markdown file under docs/ or the repo root resolves to a heading in that
     file, using GitHub's anchor rule (lower case, spaces to hyphens, punctuation dropped, underscores kept).
  5. The repository layout from JP-95: the starting folders each have a README, README.md and the docs it
     names exist, nothing in the vision is still marked Proposed, and git ignores a file inside a .phi folder.
  6. The feature list from JP-97 (docs/inventory/features.md): every row has one verdict, a reason and a carrier
     ticket, every retired row says what replaces it, and the Session Atlas focus summaries are retired.
  7. The conventions files from JP-98 exist and pass scripts/conventions.py (needs PyYAML, requirements.txt).
  8. JP-96 inventory: every row of a table with Verdict and Reason columns in docs/inventory/ (except
     features.md) has exactly one verdict of keep, migrate, build new or dismantle, and a reason; every row of a table with Date range and
     Produced by columns states both; a table of items (a "What it is" column) must have Verdict and
     Reason columns; and laptop.md and starting-figures.md must exist.

Tickets that add code add their own checks here or beside it. Exit 0 when everything passes, 1 otherwise.
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

REQUIRED = [
    "AGENTS.md",
    "docs/WORKFLOW.md",
    ".claude/workflow.config.md",
    ".claude/settings.json",
    ".github/PULL_REQUEST_TEMPLATE.md",
    ".github/workflows/test.yml",
    ".claude/agents/ceremony-reviewer.md",
    ".claude/agents/implementer.md",
] + [f".claude/skills/{s}/SKILL.md" for s in (
    "ticket-lifecycle", "design-handoff", "pr-proof", "review-ceremony", "workflow-roles",
)] + [f".claude/commands/{c}.md" for c in (
    "design", "build", "fix", "review-pr", "ship", "session-end",
)]

# JP-95: the home layout every later ticket builds into.
LAYOUT = [
    "README.md",
    "docs/decisions.md",
    "docs/vision-and-roadmap.md",
    "docs/source-notes/README.md",
    ".gitignore",
] + [f"{d}/README.md" for d in (
    "apps", "ledger", "graphs", "conventions", "docs/design", "docs/inventory", "docs/proof",
)]

# JP-98: the conventions, the system registry, the standing priorities and the surface map.
CONVENTIONS = [
    "conventions/tickets.md",
    "conventions/registry.yaml",
    "conventions/priorities.yaml",
    "docs/surface-map.md",
    "scripts/conventions.py",
    "tests/test_conventions.py",
    "requirements.txt",
]

# A status marker, not the ordinary verb: "Proposed:", "(Proposed)", "**Proposed**", "| Proposed |".
PROPOSED_MARKER = re.compile(r"(\*\*Proposed\*\*|\(Proposed\)|\bProposed:|\|\s*Proposed\s*\|)")


def phi_is_ignored() -> bool:
    """git check-ignore exits 0 when the path is ignored. --no-index also covers a file that is tracked."""
    probe = "ledger/.phi/sample.json"
    result = subprocess.run(["git", "check-ignore", "--no-index", "-q", probe], cwd=ROOT)
    return result.returncode == 0


PLACEHOLDER = re.compile(r"(?<!\$)\{\{\s*[A-Z_]+\s*\}\}")


def frontmatter(path: Path) -> dict[str, str]:
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---\n"):
        return {}
    end = text.find("\n---", 4)
    if end == -1:
        return {}
    fields = {}
    for line in text[4:end].splitlines():
        key, sep, value = line.partition(":")
        if sep:
            fields[key.strip()] = value.strip()
    return fields


def unquoted_colons(path: Path, fm: dict[str, str]) -> list[str]:
    """A plain YAML scalar may not contain ": " (strict parsers reject it), so such values must be quoted."""
    return [f"unquoted ': ' in frontmatter {key}: {path.relative_to(ROOT)}"
            for key, value in fm.items()
            if ": " in value and not (value[:1] in "'\"" and value[-1:] == value[:1])]


def github_anchor(heading: str) -> str:
    slug = heading.strip().lower()
    slug = re.sub(r"[^\w\- ]", "", slug)  # \w keeps letters, digits and underscores
    return slug.replace(" ", "-")


def anchors_in(text: str) -> set[str]:
    seen: dict[str, int] = {}
    result = set()
    in_fence = False
    for line in text.splitlines():
        if line.lstrip().startswith(("```", "~~~")):
            in_fence = not in_fence
            continue
        m = None if in_fence else re.match(r"^#{1,6}\s+(.*?)\s*#*\s*$", line)
        if m:
            base = github_anchor(m.group(1))
            n = seen.get(base, 0)
            result.add(base if n == 0 else f"{base}-{n}")
            seen[base] = n + 1
    return result


FEATURES = "docs/inventory/features.md"
VERDICTS = ("Keep as is", "Keep, move onto the ledger", "Merge with ", "Retire")
CARRIER = re.compile(r"\bJP-\d+\b|None needed")
FEATURE_ROW = re.compile(r"^\|\s*([AS]\d+)\s*\|")


def feature_list_problems(text: str) -> list[str]:
    """JP-97: every feature row has one verdict, a reason and a carrier; a retired row says what replaces it;
    the Session Atlas focus summaries are retired. Rows are the 7-column tables (ID first); the short
    "retired" summary table at the top has 3 columns and is not a feature row."""
    problems: list[str] = []
    seen: set[str] = set()
    section = ""
    for n, line in enumerate(text.splitlines(), 1):
        if line.startswith("## "):
            section = line[3:].strip()
        m = FEATURE_ROW.match(line)
        if not m or section.startswith("Answers"):
            continue  # the short summary table of retired features sits under "Answers to ..."
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) != 7:
            problems.append(f"feature row does not have 7 columns: {FEATURES}:{n} ({m.group(1)})")
            continue
        fid, feature, _what, _data, verdict, reason, carrier = cells
        where = f"{FEATURES}:{n} ({fid})"
        if fid in seen:
            problems.append(f"duplicate feature id: {where}")
        seen.add(fid)
        matches = [v for v in VERDICTS if verdict.startswith(v)]
        if len(matches) != 1 or (verdict.startswith("Keep as is") and verdict != "Keep as is"):
            problems.append(f"verdict is not exactly one of {VERDICTS}: {where}: {verdict}")
        if not reason:
            problems.append(f"no reason: {where}")
        if not CARRIER.search(carrier):
            problems.append(f"no carrier ticket or 'None needed': {where}")
        if verdict.startswith("Retire") and not re.search(r"Replaced by|Nothing replaces", reason):
            problems.append(f"retired without saying what replaces it: {where}")
        if fid.startswith("S") and feature == "Focus summaries" and verdict != "Retire":
            problems.append(f"focus summaries must be retired: {where}")
    if not seen:
        problems.append(f"no feature rows found in {FEATURES}")
    if not any(fid.startswith("S") for fid in seen) or not any(fid.startswith("A") for fid in seen):
        problems.append(f"{FEATURES} needs rows for both action-triage (A) and Session Atlas (S)")
    if "| Focus summaries |" not in text:
        problems.append(f"no Focus summaries row in {FEATURES}")
    return problems


def conventions_problems() -> list[str]:
    """scripts/conventions.py's own check of the registry and the priorities file."""
    if not ((ROOT / "conventions/registry.yaml").is_file() and (ROOT / "conventions/priorities.yaml").is_file()):
        return []  # reported as missing above
    try:
        sys.path.insert(0, str(ROOT / "scripts"))
        import conventions
    except ImportError as exc:
        return [f"cannot check conventions/: {exc} (pip install -r requirements.txt)"]
    try:
        registry, priorities = conventions.load(conventions.REGISTRY), conventions.load(conventions.PRIORITIES)
    except conventions.ConventionsFileError as exc:
        return [f"conventions: {exc}"]
    return [f"conventions: {p}" for p in conventions.validate(registry, priorities)]


INVENTORY_VERDICTS = {"keep", "migrate", "build new", "dismantle"}


def table_rows(text: str):
    """Yields (header, cells, line number) for every Markdown table body row."""
    header = None
    for n, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if not (stripped.startswith("|") and stripped.endswith("|")):
            header = None
            continue
        cells = [c.strip() for c in stripped.strip("|").split("|")]
        if header is None:
            header = cells
        elif not all(re.fullmatch(r":?-+:?", c) for c in cells):
            yield header, cells, n


def inventory_problems(path: Path) -> list[str]:
    problems = []
    rel = path.relative_to(ROOT) if path.is_relative_to(ROOT) else path
    for header, cells, n in table_rows(path.read_text(encoding="utf-8")):
        row = dict(zip(header, cells))
        if len(cells) != len(header):
            problems.append(f"inventory row has {len(cells)} cells, header has {len(header)}: {rel}:{n}")
            continue
        if "What it is" in row and not ("Verdict" in row and "Reason" in row):
            problems.append(f"inventory table of items (a 'What it is' column) without Verdict and Reason columns: {rel}:{n}")
            continue
        if "Verdict" in row and "Reason" in row:
            if row["Verdict"] not in INVENTORY_VERDICTS:
                problems.append(f"inventory row without exactly one verdict: {rel}:{n}: {row['Verdict']!r}")
            if len(row["Reason"]) < 10:
                problems.append(f"inventory row without a reason: {rel}:{n}")
        if "Date range" in row and "Produced by" in row:
            if not row["Date range"] or not row["Produced by"]:
                problems.append(f"figure without a date range or command: {rel}:{n}")
    return problems


def main() -> int:
    problems: list[str] = []

    for rel in REQUIRED:
        if not (ROOT / rel).is_file():
            problems.append(f"missing: {rel}")

    scanned = [ROOT / "AGENTS.md", ROOT / "docs/WORKFLOW.md"]
    scanned += sorted((ROOT / ".claude").rglob("*.md")) + sorted((ROOT / ".github").rglob("*.*"))
    for path in scanned:
        if path.is_file():
            for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                if PLACEHOLDER.search(line):
                    problems.append(f"unfilled value: {path.relative_to(ROOT)}:{n}: {line.strip()}")

    for skill in sorted((ROOT / ".claude/skills").glob("*/SKILL.md")):
        fm = frontmatter(skill)
        if fm.get("name") != skill.parent.name:
            problems.append(f"skill name does not match its folder: {skill.relative_to(ROOT)}")
        if not fm.get("description"):
            problems.append(f"skill has no description: {skill.relative_to(ROOT)}")
        problems += unquoted_colons(skill, fm)
    for folder in (".claude/commands", ".claude/agents"):
        for md in sorted((ROOT / folder).glob("*.md")):
            fm = frontmatter(md)
            if not fm.get("description"):
                problems.append(f"no description: {md.relative_to(ROOT)}")
            problems += unquoted_colons(md, fm)

    docs = [p for p in ROOT.glob("*.md") if p.is_file()] + sorted((ROOT / "docs").rglob("*.md"))
    docs += sorted((ROOT / "conventions").rglob("*.md"))
    for doc in docs:
        text = doc.read_text(encoding="utf-8")
        known = anchors_in(text)
        for anchor in re.findall(r"\]\(#([^)\s]+)\)", text):
            if anchor not in known:
                problems.append(f"broken anchor: {doc.relative_to(ROOT)}: #{anchor}")

    for rel in LAYOUT:
        if not (ROOT / rel).is_file():
            problems.append(f"missing: {rel}")
    vision = ROOT / "docs/vision-and-roadmap.md"
    if vision.is_file():
        for n, line in enumerate(vision.read_text(encoding="utf-8").splitlines(), 1):
            if PROPOSED_MARKER.search(line):
                problems.append(f"still marked Proposed: docs/vision-and-roadmap.md:{n}: {line.strip()}")
    if (ROOT / ".git").exists() and not phi_is_ignored():
        problems.append("not ignored: a file inside a .phi folder (.gitignore needs *[Pp][Hh][Ii])")

    features = ROOT / FEATURES
    if features.is_file():
        problems += feature_list_problems(features.read_text(encoding="utf-8"))
    else:
        problems.append(f"missing: {FEATURES}")

    for rel in CONVENTIONS:
        if not (ROOT / rel).is_file():
            problems.append(f"missing: {rel}")
    problems += conventions_problems()

    for name in ("laptop.md", "starting-figures.md"):
        if not (ROOT / "docs/inventory" / name).is_file():
            problems.append(f"JP-96 deliverable missing: docs/inventory/{name}")
    for doc in sorted((ROOT / "docs/inventory").glob("*.md")):
        if doc != ROOT / FEATURES:  # JP-97's list has its own verdicts and check (check 6)
            problems += inventory_problems(doc)

    for p in problems:
        print(p)
    print(f"check.py: {'FAILED' if problems else 'ok'} ({len(problems)} problem(s))")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
