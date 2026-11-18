"""Reading a ticket's text the way the non-development gates need to (JP-123).

Python 3.9, standard library only. A ticket's description reaches a gate as plain text, with each section opening
on a line that names it: `**Question:** ...`, `## Question`, `Question:` or a bare `Question` line. The section names
are the ones in conventions/tickets.md ("Required sections").
"""
from __future__ import annotations

import json
import re
from typing import Dict, List, Optional

INFERRED_MARKER = "(inferred)"   # a section value the drafter worked out, not one Josh gave (decisions.md, JP-123)

SECTION_NAMES = [
    "Goal", "First step", "Why", "In scope", "Not in scope", "Acceptance criteria", "Validation", "Repository",
    "Where it runs", "Parent or related", "Decisions already made", "Open questions", "Current behaviour", "Question", "Sources",
    "Deliverable format", "Phases", "Done when", "Related work", "Branch strategy",
]
_NAMES = "|".join(re.escape(n) for n in sorted(SECTION_NAMES, key=len, reverse=True))
# markup before the name (#'s, bold, bullet), the name, then closing bold and a colon in either order, then the rest
_HEADING = re.compile(
    r"^\s*(?:#{1,6}\s*)?(?:[-*]\s+)?(\*\*|__)?\s*(" + _NAMES + r")\s*(?:\1)?\s*(:)?\s*(?:\1)?\s*(.*)$",
    re.IGNORECASE)


def as_bool(value: Optional[str], default: bool = True) -> bool:
    """A gate input as a boolean. Anything but a clear true or false gives the default."""
    if value is None:
        return default
    text = value.strip().lower()
    if text in ("true", "1", "yes"):
        return True
    if text in ("false", "0", "no"):
        return False
    return default


def as_list(value: Optional[str]) -> List[object]:
    """A list input: a JSON list, or empty. Raises ValueError for text that is not a JSON list."""
    if value is None or not value.strip():
        return []
    parsed = json.loads(value)
    if not isinstance(parsed, list):
        raise ValueError("not a list")
    return parsed


def collapse(text: Optional[str]) -> str:
    """Runs of whitespace (including line breaks) become one space; the ends are trimmed."""
    return re.sub(r"\s+", " ", text or "").strip()


def _opening(line: str):
    """(the section name as written in SECTION_NAMES, the text after it on the line) when the line opens a section."""
    match = _HEADING.match(line)
    if not match:
        return None
    marked = bool(match.group(1) or match.group(3) or re.match(r"^\s*#", line))
    rest = match.group(4).strip()
    if not (marked or not rest):
        return None
    return next(n for n in SECTION_NAMES if n.lower() == match.group(2).lower()), rest


def parse_sections(description: Optional[str]) -> Dict[str, str]:
    """Each named section's text, keyed by its name as written in SECTION_NAMES. A name that opens no section is absent.

    A line opens a section when it starts with a known name and the name is marked (bold, a heading, a colon) or is
    alone on its line. The section runs to the next line that opens one.
    """
    sections: Dict[str, List[str]] = {}
    current: Optional[str] = None
    for line in (description or "").splitlines():
        opened = _opening(line)
        if opened:
            current = opened[0]
            sections.setdefault(current, [])
            if opened[1]:
                sections[current].append(opened[1])
        elif current is not None:
            sections[current].append(line)
    return {name: "\n".join(lines).strip() for name, lines in sections.items()}


def without_section(description: Optional[str], name: str) -> str:
    """The description with every line of the named section removed, its opening line included. Lines before the
    first section stay. Read a ticket's Acceptance criteria scenarios through this when the other sections hold
    scenarios of their own (the Validation block)."""
    kept: List[str] = []
    current: Optional[str] = None
    for line in (description or "").splitlines():
        opened = _opening(line)
        if opened:
            current = opened[0]
        if current != name:
            kept.append(line)
    return "\n".join(kept)


def words(text: Optional[str], minimum: int = 4) -> List[str]:
    """Lower-cased words of `minimum` letters or more, each once, in the order they first appear."""
    seen: List[str] = []
    for word in re.findall(r"[A-Za-z][A-Za-z'-]*", text or ""):
        word = word.strip("'-").lower()
        if len(word) >= minimum and word not in seen:
            seen.append(word)
    return seen


def strip_marker(text: str) -> str:
    """The section text without the inferred marker."""
    return collapse(re.sub(re.escape(INFERRED_MARKER), "", text, flags=re.IGNORECASE))


def is_inferred(text: str) -> bool:
    return INFERRED_MARKER in (text or "").lower()


def quotes(source: str, quote: object) -> bool:
    """True when `quote` appears in `source`, whitespace collapsed. Quote marks around the quote do not count."""
    if not isinstance(quote, str):
        return False
    wanted = collapse(quote).strip("\"'`“”‘’").strip()
    return bool(wanted) and wanted in collapse(source)


def shorten(text: str, limit: int) -> str:
    """The text cut at a word boundary to at most `limit` characters, with an ellipsis when cut."""
    text = collapse(text)
    if len(text) <= limit:
        return text
    cut = text[:limit - 1].rsplit(" ", 1)[0].rstrip(" ,;:")
    return (cut or text[:limit - 1]) + "…"
