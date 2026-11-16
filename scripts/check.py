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

Tickets that add code add their own checks here or beside it. Exit 0 when everything passes, 1 otherwise.
"""
from __future__ import annotations

import re
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
    for doc in docs:
        text = doc.read_text(encoding="utf-8")
        known = anchors_in(text)
        for anchor in re.findall(r"\]\(#([^)\s]+)\)", text):
            if anchor not in known:
                problems.append(f"broken anchor: {doc.relative_to(ROOT)}: #{anchor}")

    for p in problems:
        print(p)
    print(f"check.py: {'FAILED' if problems else 'ok'} ({len(problems)} problem(s))")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
