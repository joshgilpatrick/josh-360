#!/usr/bin/env python3
"""The documentation checks (JP-158), run by scripts/check.py.

  1. Every "](#anchor)" link and every relative link in a git-tracked Markdown file resolves: the file or
     folder exists, and a "#anchor" on a Markdown target names one of its headings (GitHub's anchor rule,
     from check.py). Fenced code, inline code and graphs/tests/fixtures are skipped.
  2. Every top-level folder that is not hidden has a README.md that opens with a paragraph.
  3. graphs/roles/README.md and graphs/agents/README.md name every role and agent folder.
  4. The verify-josh-360 skill keeps its shape: frontmatter name verify-josh-360, a description naming Josh 360
     and its surfaces, Launch, Doctor, Drive, Evidence and Cleanup sections, no placeholder left, and an
     executable sandbox.py that parses as Python 3.9.
  5. Each feature file in its features/ folder has exactly the four sections "Sub-features",
     "How to get to it (user POV)", "Driving it with <harness>" and "Gotchas", in that order, and
     features/README.md links to every feature file.

Prints one line per problem. Exit 0 when everything passes, 1 otherwise.
"""
from __future__ import annotations

import ast
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from check import anchors_in  # noqa: E402

SKIPPED = ("graphs/tests/fixtures/", "node_modules/", ".claude/worktrees/")
LINK = re.compile(r"\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
SKILL = ".claude/skills/verify-josh-360"
SKILL_SECTIONS = ("Launch", "Doctor", "Drive", "Evidence", "Cleanup")
SURFACES = ("hooks", "jobs", "ledger", "doctor", "walker")
FEATURE_SECTIONS = ("Sub-features", "How to get to it (user POV)", "Driving it with ", "Gotchas")
LEFTOVER = re.compile(r"\b(TODO|TBD|FIXME)\b|\{\{|<harness>|<placeholder>")


def tracked_markdown(root: Path) -> list[Path]:
    """Git-tracked Markdown files, plus untracked ones not ignored, so a new doc is checked before its commit."""
    try:
        out = subprocess.run(["git", "ls-files", "-co", "--exclude-standard", "*.md"], cwd=root,
                             capture_output=True, text=True, check=True).stdout
        names = out.splitlines()
    except (OSError, subprocess.CalledProcessError):
        names = [str(p.relative_to(root)) for p in root.rglob("*.md")]
    return [root / n for n in sorted(set(names))
            if not any(n.startswith(s) or f"/{s}" in n for s in SKIPPED) and (root / n).is_file()]


def prose(text: str) -> str:
    """The text with fenced code blocks and inline code removed, so example links are not checked."""
    lines, in_fence = [], False
    for line in text.splitlines():
        if line.lstrip().startswith(("```", "~~~")):
            in_fence = not in_fence
            lines.append("")
            continue
        lines.append("" if in_fence else re.sub(r"`[^`]*`", "", line))
    return "\n".join(lines)


def link_problems(root: Path, doc: Path) -> list[str]:
    rel = doc.relative_to(root)
    text = doc.read_text(encoding="utf-8")
    problems = []
    for target in LINK.findall(prose(text)):
        target = target.strip("<>")
        if re.match(r"^[a-z][a-z0-9+.-]*:", target, re.I) or target.startswith("//"):
            continue  # http:, https:, mailto: and the like
        path_part, _, anchor = target.partition("#")
        if not path_part:
            if anchor and anchor not in anchors_in(text):
                problems.append(f"broken anchor: {rel}: #{anchor}")
            continue
        dest = (root / path_part.lstrip("/")) if path_part.startswith("/") else (doc.parent / path_part)
        if not dest.exists():
            problems.append(f"broken link: {rel}: {target}")
        elif anchor and dest.is_file() and dest.suffix == ".md":
            if anchor not in anchors_in(dest.read_text(encoding="utf-8")):
                problems.append(f"broken anchor: {rel}: {target}")
    return problems


def first_paragraph(text: str) -> str:
    for block in re.split(r"\n\s*\n", text):
        block = block.strip()
        if block and not block.startswith(("#", "|", "-", "*", ">", "```", "<!--")):
            return block
    return ""


def readme_problems(root: Path) -> list[str]:
    problems = []
    for folder in sorted(p for p in root.iterdir() if p.is_dir() and not p.name.startswith(".")):
        readme = folder / "README.md"
        if not readme.is_file():
            problems.append(f"top-level folder has no README.md: {folder.name}/")
        elif not first_paragraph(readme.read_text(encoding="utf-8")):
            problems.append(f"README.md does not open with a paragraph saying what the folder holds: {folder.name}/")
    return problems


def listing_problems(root: Path) -> list[str]:
    problems = []
    for kind in ("roles", "agents"):
        base = root / "graphs" / kind
        readme = base / "README.md"
        if not readme.is_file():
            continue  # check.py reports the missing README
        text = readme.read_text(encoding="utf-8")
        for folder in sorted(p for p in base.iterdir() if p.is_dir()):
            if not re.search(rf"(?<![\w-]){re.escape(folder.name)}(?![\w-])", text):
                problems.append(f"graphs/{kind}/README.md does not name {folder.name}")
    return problems


def h2s(text: str) -> list[str]:
    return [m.group(1).strip() for m in re.finditer(r"^##\s+(.*?)\s*$", prose(text), re.M)]


def frontmatter(text: str) -> dict[str, str]:
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    fm = {}
    for line in (m.group(1).splitlines() if m else []):
        key, sep, value = line.partition(":")
        if sep:
            fm[key.strip()] = value.strip().strip("'\"")
    return fm


def skill_problems(root: Path) -> list[str]:
    skill = root / SKILL
    path = skill / "SKILL.md"
    if not path.is_file():
        return [f"missing: {SKILL}/SKILL.md"]
    text = path.read_text(encoding="utf-8")
    fm = frontmatter(text)
    problems = []
    if fm.get("name") != "verify-josh-360":
        problems.append(f"{SKILL}/SKILL.md: frontmatter name is not verify-josh-360")
    desc = fm.get("description", "").lower()
    if "josh 360" not in desc:
        problems.append(f"{SKILL}/SKILL.md: description does not name Josh 360")
    missing = [s for s in SURFACES if s not in desc]
    if missing:
        problems.append(f"{SKILL}/SKILL.md: description does not name these surfaces: {', '.join(missing)}")
    sections = h2s(text)
    for name in SKILL_SECTIONS:
        if name not in sections:
            problems.append(f"{SKILL}/SKILL.md: no '## {name}' section")
    for n, line in enumerate(prose(text).splitlines(), 1):
        if LEFTOVER.search(line):
            problems.append(f"{SKILL}/SKILL.md:{n}: placeholder left: {line.strip()}")

    script = skill / "scripts" / "sandbox.py"
    if not script.is_file():
        problems.append(f"missing: {SKILL}/scripts/sandbox.py")
    else:
        if not os.access(script, os.X_OK):
            problems.append(f"not executable: {SKILL}/scripts/sandbox.py")
        try:
            ast.parse(script.read_text(encoding="utf-8"), feature_version=(3, 9))
        except SyntaxError as exc:
            problems.append(f"{SKILL}/scripts/sandbox.py does not parse as Python 3.9: {exc}")
    return problems + feature_problems(skill / "features")


def feature_problems(features: Path) -> list[str]:
    index = features / "README.md"
    if not index.is_file():
        return [f"missing: {features.relative_to(features.parents[3])}/README.md"]
    rel = f"{SKILL}/features"
    index_links = {t.partition("#")[0] for t in LINK.findall(prose(index.read_text(encoding="utf-8")))}
    problems = []
    files = sorted(p for p in features.glob("*.md") if p.name != "README.md")
    if not files:
        problems.append(f"{rel}: no feature files")
    for f in files:
        text = f.read_text(encoding="utf-8")
        sections = h2s(text)
        ok = len(sections) == len(FEATURE_SECTIONS) and all(
            s.startswith(want) if want.endswith(" ") else s == want for s, want in zip(sections, FEATURE_SECTIONS))
        if ok and sections[2] == FEATURE_SECTIONS[2].strip():
            ok = False  # "Driving it with" must name the harness
        if not ok:
            problems.append(f"{rel}/{f.name}: sections must be exactly Sub-features, How to get to it (user POV), "
                            f"Driving it with <harness>, Gotchas; found: {', '.join(sections) or 'none'}")
        for n, line in enumerate(prose(text).splitlines(), 1):
            if LEFTOVER.search(line):
                problems.append(f"{rel}/{f.name}:{n}: placeholder left: {line.strip()}")
        if f.name not in index_links and f"./{f.name}" not in index_links:
            problems.append(f"{rel}/README.md does not link to {f.name}")
    return problems


def problems(root: Path = ROOT) -> list[str]:
    found = []
    for doc in tracked_markdown(root):
        found += link_problems(root, doc)
    found += readme_problems(root)
    found += listing_problems(root)
    found += skill_problems(root)
    return found


def main() -> int:
    found = problems()
    for p in found:
        print(p)
    print(f"docs_check.py: {'FAILED' if found else 'ok'} ({len(found)} problem(s))")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main())
