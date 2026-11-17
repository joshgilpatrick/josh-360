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


def to_marked(node: Optional[dict]) -> str:
    """Like to_text, but it keeps what a reader of a ticket needs to find its sections: strong text is wrapped in
    ``**``, a code block is fenced (```` ```gherkin ````), and a list item starts with "- ". Triage reads tickets
    through this, so a bold label opens a section and a heading or plain line does not."""
    if not isinstance(node, dict):
        return ""
    kind = node.get("type")
    if kind == "text":
        text = str(node.get("text", ""))
        if any(m.get("type") == "strong" for m in node.get("marks") or []) and text.strip():
            lead = text[:len(text) - len(text.lstrip())]
            trail = text[len(text.rstrip()):]
            return lead + "**" + text.strip() + "**" + trail
        return text
    if kind == "hardBreak":
        return "\n"
    if kind == "mention":
        return str((node.get("attrs") or {}).get("text", ""))
    if kind == "codeBlock":
        language = str((node.get("attrs") or {}).get("language") or "")
        body = "".join(str(c.get("text", "")) for c in node.get("content") or [])
        return "```" + language + "\n" + body.strip("\n") + "\n```\n"
    inner = "".join(to_marked(child) for child in node.get("content") or [])
    if kind == "listItem":
        return "- " + inner.strip("\n").replace("\n", "\n  ") + "\n"
    if kind in ("bulletList", "orderedList"):
        return inner
    if kind in BLOCKS:
        return inner + "\n"
    return inner


def plain(node: Optional[dict]) -> str:
    """to_text without the trailing line break."""
    return to_text(node).strip("\n")


def bullets(items: List[str]) -> dict:
    return {"type": "bulletList", "content": [{"type": "listItem", "content": [paragraph(str(i))]} for i in items]}


def code_block(text: str, language: str = "gherkin") -> dict:
    return {"type": "codeBlock", "attrs": {"language": language}, "content": [text_node(text.strip("\n"))]}


def labelled(label: str, body: str) -> dict:
    return {"type": "paragraph", "content": [text_node(label + ":", bold=True)] + ([text_node(" ")] + _inline(body)
                                                                                     if body else [])}


def ticket_description(ticket: dict) -> dict:
    """Josh's ticket format (conventions/tickets.md, "Required sections") as ADF: a bold label per section, real
    bullets and a Gherkin code block, in the order the checklist gives, then Repository and Where it runs."""
    from lib import ready_checklist  # the gate's own folder is on sys.path

    sections = ticket.get("sections") or {}
    blocks: List[dict] = []
    for check in ready_checklist.CHECKLIST.get(ticket.get("type"), []):
        value = sections.get(check["section"])
        kind = check["kind"]
        if kind in ("list", "list_or_empty"):
            blocks.append(labelled(check["label"], ""))
            if value:
                blocks.append(bullets(value))
            elif kind == "list_or_empty":
                blocks.append(paragraph("None."))
        elif kind == "gherkin":
            blocks.append(labelled(check["label"], ""))
            blocks.append(code_block(str(value or "")))
        else:
            blocks.append(labelled(check["label"], str(value or "")))
        if check["section"] == "acceptance_criteria":
            blocks.append(labelled("Repository", str(ticket.get("repository") or "")))
            blocks.append(labelled("Where it runs", str(ticket.get("where_it_runs") or "")))
    open_questions = sections.get("open_questions")
    if ticket.get("type") == "Research" and isinstance(open_questions, list) and open_questions:
        blocks.append(labelled("Open questions", ""))   # a Research ticket's questions are its work (triage rule 6)
        blocks.append(bullets(open_questions))
    if ticket.get("type") in ("Epic", "Subtask"):
        if ticket.get("repository"):
            blocks.append(labelled("Repository", str(ticket["repository"])))
    return doc(*blocks)
