"""The sign-off defect filter and the author check (JP-122; spec, "What the sign-off agent judges" and "An author never
signs off its own ticket"). Python 3.9, standard library only.

A defect survives only if it names J1 to J5, quotes the ticket exactly (after folding), and says what is wrong and what
is needed. A defect that cites nothing cannot survive: that is the stop rule against endless nitpicking.
"""
from __future__ import annotations

import re
from typing import Dict, List, Tuple

JUDGMENTS = ("J1", "J2", "J3", "J4", "J5")
_QUOTES = str.maketrans({"\u201c": '"', "\u201d": '"', "\u201e": '"', "\u2018": "'", "\u2019": "'", "\u200b": ""})


def fold(text: str) -> str:
    """Lower case, typographic quotes to straight, every run of whitespace (non-breaking spaces too) to one space."""
    return re.sub(r"\s+", " ", (text or "").translate(_QUOTES)).strip().lower()


def _clean_quote(quote: str) -> str:
    return fold(quote).strip("\"'`").strip()


def filter_defects(defects, ticket_text: str) -> Tuple[List[dict], List[dict]]:
    """(kept, dropped). A dropped defect is `{"defect": ..., "reason": ...}`; only the reason names why."""
    kept: List[dict] = []
    dropped: List[dict] = []
    haystack = fold(ticket_text)
    for defect in defects if isinstance(defects, list) else []:
        reason = ""
        if not isinstance(defect, dict):
            reason = "not a defect entry"
        elif defect.get("item") not in JUDGMENTS:
            reason = "item is not J1 to J5"
        elif not all(isinstance(defect.get(k), str) and defect.get(k).strip() for k in ("quote", "problem", "needed")):
            reason = "quote, problem or needed is empty"
        elif not _clean_quote(defect["quote"]) or _clean_quote(defect["quote"]) not in haystack:
            reason = "quote not in ticket"
        if reason:
            dropped.append({"defect": defect, "reason": reason})
        else:
            kept.append({k: defect[k] for k in ("item", "quote", "problem", "needed")})
    return kept, dropped


def signer_is_author(signer: str, authors: List[str]) -> bool:
    return bool(signer) and signer in [a for a in authors if a]
