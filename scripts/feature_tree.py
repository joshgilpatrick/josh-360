#!/usr/bin/env python3
"""The JP-143 feature tree: check it, and build the review page from it.

The tree (docs/design/feature-tree/tree.yaml) lists every feature of action-triage, claude-360 and
macbook-automations, plus agent-deck's laptop hooks, with a keep or drop call and a rationale. The review page
(docs/design/feature-tree/review-page.html) is built from the tree and a template, and is what gets published
for Josh to tick, untick and comment on.

    python3 scripts/feature_tree.py check   # check the tree and that the built page is up to date
    python3 scripts/feature_tree.py build   # rebuild the page after editing the tree or the template

Needs PyYAML (requirements.txt).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
FOLDER = ROOT / "docs/design/feature-tree"
TREE = FOLDER / "tree.yaml"
TEMPLATE = FOLDER / "page.template.html"
PAGE = FOLDER / "review-page.html"
PLACEHOLDER = "/*__DATA__*/null"

CALLS = {"keep", "drop"}
HOW = {"keep": {"as-is", "ledger", "rebuilt", "merged"}, "drop": {"retire", "outside", "merged"}}
# Every row of docs/inventory/features.md (JP-97) must appear in the tree.
REQUIRED_IDS = [f"A{n}" for n in range(1, 36)] + [f"S{n}" for n in range(1, 17)]


def load(path: Path = TREE) -> dict:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def walk(nodes, depth=0):
    for node in nodes or []:
        yield node, depth
        yield from walk(node.get("children"), depth + 1)


def problems(data: dict) -> list[str]:
    """Every problem with the tree, as readable lines. An empty list means the tree is good."""
    out: list[str] = []
    homes = data.get("homes") or {}
    tree = data.get("tree") or []
    if not tree:
        return ["the tree is empty"]
    seen: dict[str, int] = {}
    nodes = list(walk(tree))
    for node, _ in nodes:
        nid = node.get("id")
        if not nid or not isinstance(nid, str):
            out.append(f"a node has no id: {node.get('name')!r}")
            continue
        seen[nid] = seen.get(nid, 0) + 1
    out += [f"{nid}: id used {n} times" for nid, n in seen.items() if n > 1]
    for node, depth in nodes:
        nid = node.get("id", "?")
        if not node.get("name"):
            out.append(f"{nid}: no name")
        call = node.get("call")
        if call is None:
            if not node.get("children"):
                out.append(f"{nid}: a group with no children (give it a call or children)")
            continue
        if depth < 2:
            out.append(f"{nid}: a repo or area cannot carry a call")
        if call not in CALLS:
            out.append(f"{nid}: call must be keep or drop, not {call!r}")
            continue
        for field in ("what", "why"):
            if not str(node.get(field) or "").strip():
                out.append(f"{nid}: no {field}")
        how = node.get("how")
        if how not in HOW[call]:
            out.append(f"{nid}: how must be one of {sorted(HOW[call])} for {call}, not {how!r}")
        if call == "keep" and node.get("home") not in homes:
            out.append(f"{nid}: home {node.get('home')!r} is not one of the homes")
        if call == "drop" and node.get("home"):
            out.append(f"{nid}: a dropped feature has no home")
        if how == "merged" and call == "drop":
            into = node.get("into")
            if into not in seen:
                out.append(f"{nid}: merged into {into!r}, which is not in the tree")
            elif into == nid:
                out.append(f"{nid}: merged into itself")
    out += [f"{rid}: a features.md row missing from the tree" for rid in REQUIRED_IDS if rid not in seen]
    return out


def render(data: dict, template: str) -> str:
    if template.count(PLACEHOLDER) != 1:
        raise ValueError(f"the template must hold {PLACEHOLDER} exactly once")
    blob = json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    blob = blob.replace("</", "<\\/")  # keep "</script>" inside a string from closing the script
    return template.replace(PLACEHOLDER, blob)


def counts(data: dict) -> dict:
    keep = drop = 0
    for node, _ in walk(data["tree"]):
        if node.get("call") == "keep":
            keep += 1
        elif node.get("call") == "drop":
            drop += 1
    return {"keep": keep, "drop": drop}


def main(argv: list[str]) -> int:
    cmd = argv[1] if len(argv) > 1 else "check"
    data = load()
    found = problems(data)
    if found:
        print("feature tree: " + str(len(found)) + " problem(s)")
        for line in found:
            print("  " + line)
        return 1
    page = render(data, TEMPLATE.read_text(encoding="utf-8"))
    if cmd == "build":
        PAGE.write_text(page, encoding="utf-8")
        print(f"built {PAGE.relative_to(ROOT)}: {counts(data)}")
        return 0
    if cmd == "check":
        if not PAGE.exists() or PAGE.read_text(encoding="utf-8") != page:
            print(f"feature tree: {PAGE.relative_to(ROOT)} is out of date; run python3 scripts/feature_tree.py build")
            return 1
        print(f"feature tree ok: {counts(data)}")
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
