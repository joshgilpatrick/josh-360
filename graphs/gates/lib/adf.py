"""Atlassian Document Format helpers for the gate scripts (JP-121).

Python 3.9, standard library only: it runs on the laptop.

    paragraphs(text) -> dict       plain text as an ADF document (a blank line starts a new paragraph)
    to_text(node) -> str           an ADF document, or None, as plain text
    ticket_description(sections, ticket_type) -> dict    Josh's ticket format (see conventions/tickets.md)
"""
from __future__ import annotations

from typing import Dict, List, Optional

BLOCKS = {"paragraph", "heading", "codeBlock", "blockquote", "listItem", "bulletList", "orderedList",
          "tableRow", "rule"}


def text_node(text: str, bold: bool = False) -> dict:
    node = {"type": "text", "text": text}
    if bold:
        node["marks"] = [{"type": "strong"}]
    return node


def _inline(text: str) -> List[dict]:
    """Text with single line breaks as hard breaks; empty text gives no nodes (ADF refuses an empty text node)."""
    nodes: List[dict] = []
    for i, line in enumerate(text.split("\n")):
        if i:
            nodes.append({"type": "hardBreak"})
        if line:
            nodes.append(text_node(line))
    return nodes


def paragraph(text: str) -> dict:
    return {"type": "paragraph", "content": _inline(text)}


def doc(*blocks: dict) -> dict:
    return {"type": "doc", "version": 1, "content": list(blocks)}


def paragraphs(text: str) -> dict:
    """Plain text as a document: blank lines split paragraphs. Empty text gives one empty paragraph."""
    parts = [p for p in (text or "").replace("\r\n", "\n").split("\n\n") if p.strip()]
    return doc(*[paragraph(p.strip("\n")) for p in parts]) if parts else doc({"type": "paragraph", "content": []})


def to_text(node: Optional[dict]) -> str:
    """The plain text of an ADF node. Blocks end with a line break; list items start with "- "."""
    if not isinstance(node, dict):
        return ""
    kind = node.get("type")
    if kind == "text":
        return str(node.get("text", ""))
    if kind == "hardBreak":
        return "\n"
    if kind == "mention":
        return str((node.get("attrs") or {}).get("text", ""))
    inner = "".join(to_text(child) for child in node.get("content") or [])
    if kind == "listItem":
        return "- " + inner.strip("\n").replace("\n", "\n  ") + "\n"
    if kind in ("bulletList", "orderedList"):
        return inner  # each item already ends its own line
    if kind in BLOCKS:
        return inner + "\n"
    return inner


def plain(node: Optional[dict]) -> str:
    """to_text without the trailing line break."""
    return to_text(node).strip("\n")
