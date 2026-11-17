"""The patient-data scan shared by the gates and the ledger (JP-149).

The rule is in docs/design/data-model.md, "Patient data". In short: every system may hold patient data, the
ledger avoids patient names, dates of birth, social security numbers and phone numbers (unique identifiers such
as record numbers are allowed there), and nothing that names a patient is written to GitHub or Jira.

This is a screen, not a proof. It catches a few shapes and copied source text. It cannot catch a name typed
fresh, because no pattern tells a patient's name from any other word; only a labelled name ("Patient: ...") is
caught.

Python 3.9, standard library only: it runs on the laptop.

    scan(text, source_text, flagged, external=False) -> list[str]
        Problems, empty when clean. Each problem is a kind ("ssn-shape", "copied-source", ...), never the text.
    screen(text, external=False) -> list[str]
        The pattern screen alone.

external=True is for text written to GitHub or Jira: it adds labelled record numbers ("MRN 1234"), which the
ledger allows. A bare run of digits is not screened anywhere, because it cannot be told from a run id or a
timestamp; the copy check catches one copied from a source.
"""
from __future__ import annotations

import re
from typing import List, Optional

COPY_RUN = 10  # characters of source text that make a copy (action-triage's PHI guard rule)

# Josh's list for the ledger: names (labelled only), dates of birth, social security numbers, phone numbers.
LEDGER_PATTERNS = [
    ("ssn-shape", re.compile(r"(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)")),
    ("labelled-dob", re.compile(
        r"(?i)\b(?:d\.?o\.?b\.?|date\s+of\s+birth|birth\s?date|born(?:\s+on)?)(?![a-z])[^\d\n]{0,12}\d")),
    ("old-date", re.compile(  # a year from 1900 to 2009: a date of birth more often than a work date
        r"(?<!\d)(?:(?:19\d\d|200\d)-\d{1,2}-\d{1,2}|\d{1,2}/\d{1,2}/(?:19\d\d|200\d))(?!\d)")),
    ("phone", re.compile(
        r"(?<![\d\w])(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?!\d)")),
    ("labelled-name", re.compile(
        r"(?i:\bpatient(?:'s)?)(?:(?i:\s+name)\s*[:=-]?|\s*[:=])\s*[A-Z][a-z]+")),
]

# Added for GitHub and Jira, where a record number counts as a patient identifier.
EXTERNAL_PATTERNS = [
    ("labelled-id", re.compile(
        r"(?i)\b(?:mrn|medical\s+record(?:\s+(?:number|no\.?|#))?|patient\s+id|member\s+id"
        r"|chart\s+(?:number|no\.?|#))(?![a-z])[^\d\n]{0,6}\d")),
]


def _collapse(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().casefold()


def copied(text: str, source_text: Optional[str]) -> bool:
    """True when text repeats a run of COPY_RUN or more characters of source_text, whitespace collapsed."""
    if not source_text:
        return False
    source, target = _collapse(source_text), _collapse(text)
    if len(source) < COPY_RUN:
        return False
    return any(source[i:i + COPY_RUN] in target for i in range(len(source) - COPY_RUN + 1))


def screen(text: Optional[str], external: bool = False) -> List[str]:
    """The kinds of identifier found in text, sorted, each once."""
    if not text:
        return []
    patterns = LEDGER_PATTERNS + (EXTERNAL_PATTERNS if external else [])
    return sorted({kind for kind, pattern in patterns if pattern.search(text)})


def scan(text: Optional[str], source_text: Optional[str], flagged: bool, external: bool = False) -> List[str]:
    """Every problem with text. flagged is a run marked phi: there, every non-empty text is a problem."""
    if not text or not text.strip():
        return []
    problems = set(screen(text, external))
    if flagged:
        problems.add("flagged")
    if copied(text, source_text):
        problems.add("copied-source")
    return sorted(problems)
