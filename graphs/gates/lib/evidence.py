"""Reads the evidence file's front block (contract graphs/contracts/evidence.md, JP-104/JP-123).

Python 3.9, standard library only: gates run on the laptop's /usr/bin/python3, which has no YAML reader. The block is
the flat YAML the contract describes, and this parser reads exactly that shape and nothing more:

    key: value                 a scalar, bare or in quotes
    key: [a, b]                a list on one line (or [] for none)
    key:                       then "- item" lines, each a scalar or a mapping (`- type: query` and its
      - type: query            indented `ref: ...` lines)
        ref: x.sql
    key: |  or  key: >         a block of text, indented below

The block sits between two `---` lines (or a ```yaml fence) at the top of the file. Anything else raises EvidenceError.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Dict, List, Optional


class EvidenceError(Exception):
    """The file is not an evidence file this parser can read. The message never quotes the file's content."""


def _scalar(text: str):
    text = text.strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'":
        inner = text[1:-1]
        return inner.replace('\\"', '"').replace("\\\\", "\\") if text[0] == '"' else inner.replace("''", "'")
    low = text.lower()
    if low in ("true", "yes"):
        return True
    if low in ("false", "no"):
        return False
    if text in ("", "~") or low == "null":
        return ""
    return text


def _flow_items(text: str) -> List[str]:
    """Split the inside of a [...] list on commas that are not in quotes."""
    items, current, quote = [], "", ""
    for char in text:
        if quote:
            current += char
            if char == quote:
                quote = ""
        elif char in "\"'":
            quote = char
            current += char
        elif char == ",":
            items.append(current)
            current = ""
        else:
            current += char
    if current.strip():
        items.append(current)
    return [item.strip() for item in items if item.strip()]


def _flow_value(text: str):
    text = text.strip()
    if text.startswith("[") and text.endswith("]"):
        return [_scalar(item) for item in _flow_items(text[1:-1])]
    if text.startswith("{") and text.endswith("}"):
        mapping: Dict[str, object] = {}
        for item in _flow_items(text[1:-1]):
            key, _, value = item.partition(":")
            mapping[key.strip()] = _scalar(value)
        return mapping
    return _scalar(text)


def _block_lines(path_text: str) -> List[str]:
    lines = path_text.splitlines()
    start = None
    for index, line in enumerate(lines[:8]):
        if line.strip() == "---" or re.match(r"^```\s*ya?ml\s*$", line.strip()):
            start = index
            fence = line.strip() != "---"
            break
    if start is None:
        raise EvidenceError("the evidence file has no front block between --- lines")
    block: List[str] = []
    for line in lines[start + 1:]:
        if (not fence and line.strip() == "---") or (fence and line.strip() == "```"):
            return block
        block.append(line)
    raise EvidenceError("the evidence file's front block is never closed")


def _indent(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def parse(text: str) -> Dict[str, object]:
    """The front block as a dict. A `sources` or `deliverables` entry is always a list."""
    lines = [ln for ln in _block_lines(text) if ln.strip() and not ln.lstrip().startswith("#")]
    result: Dict[str, object] = {}
    i = 0
    while i < len(lines):
        line = lines[i]
        if _indent(line) != 0 or ":" not in line:
            raise EvidenceError("the evidence front block has a line that is not 'key: value'")
        key, _, rest = line.partition(":")
        key, rest = key.strip(), rest.strip()
        i += 1
        if rest in ("|", ">", "|-", ">-"):
            body: List[str] = []
            while i < len(lines) and _indent(lines[i]) > 0:
                body.append(lines[i].strip())
                i += 1
            result[key] = (" " if rest.startswith(">") else "\n").join(body)
        elif rest == "":
            items: List[object] = []
            while i < len(lines) and _indent(lines[i]) > 0:
                stripped = lines[i].strip()
                if not stripped.startswith("-"):
                    raise EvidenceError("the evidence front block has a list item that does not start with '-'")
                first = stripped[1:].strip()
                base = _indent(lines[i])
                i += 1
                if re.match(r"^[A-Za-z_][\w -]*:(\s|$)", first) and not first.startswith(("[", "{", '"', "'")):
                    item: Dict[str, object] = {}
                    k, _, v = first.partition(":")
                    item[k.strip()] = _flow_value(v)
                    while i < len(lines) and _indent(lines[i]) > base and not lines[i].strip().startswith("-"):
                        k, _, v = lines[i].strip().partition(":")
                        item[k.strip()] = _flow_value(v)
                        i += 1
                    items.append(item)
                else:
                    items.append(_flow_value(first))
            result[key] = items
        else:
            result[key] = _flow_value(rest)
    for name in ("sources", "deliverables"):
        value = result.get(name)
        if value in (None, ""):
            result[name] = []
        elif not isinstance(value, list):
            result[name] = [value]
    return result


def load(path: Path) -> Dict[str, object]:
    """Read and parse an evidence file. Raises EvidenceError (never quoting the file) when it cannot."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise EvidenceError("the evidence file cannot be read ({})".format(exc.__class__.__name__))
    return parse(text)


def text_of(doc: Dict[str, object], key: str) -> str:
    value = doc.get(key)
    return value.strip() if isinstance(value, str) else ""


def flag(doc: Dict[str, object], key: str) -> Optional[bool]:
    value = doc.get(key)
    return value if isinstance(value, bool) else None


def sources(doc: Dict[str, object]) -> List[Dict[str, str]]:
    """The source rows that are mappings with a type and a ref; anything else is left out."""
    rows = []
    for item in doc.get("sources") or []:
        if isinstance(item, dict) and isinstance(item.get("type"), str) and isinstance(item.get("ref"), str) \
                and item["ref"].strip():
            rows.append({"type": item["type"].strip(), "ref": item["ref"].strip(),
                         "used_for": str(item.get("used_for", "")).strip()})
    return rows
