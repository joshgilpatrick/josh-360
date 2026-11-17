"""Cut, check and withhold short text before it is written to the ledger (JP-107, Task 2).

Twelve columns hold free text (docs/design/data-model.md, "Patient data"), each capped by a CHECK in
ledger/schema.sql. Every writer sends its text through `short_text` first, so a long line is cut and a line that
fails the patient-data screen is withheld, never refused by the database and never the reason a whole session is
dropped. The screen is the shared graphs/gates/lib/patient_data.py, called with external=False (Josh's list for the
ledger: SSN shape, labelled date of birth, old date, phone number, labelled name; record numbers pass).

Python 3.9, standard library only.
"""
from __future__ import annotations

import re
from typing import Dict, Optional, Tuple

from ledger import _repo  # noqa: F401  (puts graphs/gates on sys.path)
from lib import patient_data  # noqa: E402

WITHHELD = "withheld: patient data"

# The twelve free-text columns and their caps, as ledger/schema.sql declares them. tests/test_ledger_text.py checks
# every entry against the schema, so the two cannot drift.
CAPS: Dict[Tuple[str, str], int] = {
    ("session_episodes", "title"): 120,
    ("session_summaries", "lines"): 800,
    ("session_state_notes", "note"): 300,
    ("step_results", "note"): 200,
    ("asks", "question"): 500,
    ("asks", "choices"): 500,
    ("asks", "suggested_answer"): 500,
    ("decisions", "answer"): 500,
    ("category_stages", "reason"): 200,
    ("branch_marks", "note"): 200,
    ("session_homes", "evidence"): 300,
    ("machines", "label"): 60,
}

_WHITESPACE = re.compile(r"\s+")


def short_text(text: Optional[str], cap: int, *, one_line: bool = True, phi: bool = False,
               source_text: Optional[str] = None) -> Tuple[Optional[str], bool]:
    """(the text to store, whether it was withheld).

    - Empty or blank text gives (None, False).
    - Text that fails the patient-data screen (or any text when phi is true) gives (WITHHELD, True). The caller
      decides what that means for its column: a title is stored empty with source "withheld", a note is dropped.
    - Otherwise line breaks become spaces when one_line, and text over the cap is cut to exactly cap characters,
      ending in an ellipsis. The screen runs on the whole text first, so a phone number cannot slip past the cut.
    """
    if text is None or not text.strip():
        return None, False
    if patient_data.scan(text, source_text, phi, external=False):
        return WITHHELD, True
    out = _WHITESPACE.sub(" ", text).strip() if one_line else text.strip()
    if len(out) > cap:
        out = out[:cap - 1].rstrip() + "…"
    return out, False
