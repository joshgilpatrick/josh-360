#!/usr/bin/env python3
"""The JP-144 architecture page: build it from the feature tree, and check it is up to date.

The page (docs/design/architecture/architecture.html) shows josh-360 as one app: its layers, how data
moves, what each existing thing contributes, and what phase 1 builds. Its salvage map is drawn from the
feature tree (docs/design/feature-tree/tree.yaml, JP-143 and Josh's review in JP-145) plus the rows in
docs/design/architecture/laptop-pieces.yaml for claude-harness and the rest of the laptop. The page embeds
both, so it has to be rebuilt when either changes; `check` fails until it is.

    python3 scripts/architecture_page.py check   # check the extra rows and that the built page is up to date
    python3 scripts/architecture_page.py build   # rebuild the page after editing the tree, the rows or the template

Needs PyYAML (requirements.txt).
"""
from __future__ import annotations

import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
import feature_tree  # noqa: E402  (same folder)

ROOT = feature_tree.ROOT
FOLDER = ROOT / "docs/design/architecture"
PIECES = FOLDER / "laptop-pieces.yaml"
TEMPLATE = FOLDER / "page.template.html"
PAGE = FOLDER / "architecture.html"

ROW_HOW = {"as-is", "ledger", "rebuilt", "retire", "outside"}
# The fields of a tree node the page uses; everything else stays in tree.yaml.
NODE_FIELDS = ("id", "name", "about", "what", "call", "how", "home", "into", "why", "carrier")


def load_pieces(path: Path = PIECES) -> dict:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def piece_problems(pieces: dict, tree_ids: set[str]) -> list[str]:
    problems: list[str] = []
    rows = pieces.get("rows") or []
    if not rows:
        problems.append("laptop-pieces.yaml has no rows")
    seen: set[str] = set()
    for row in rows:
        rid = row.get("id", "?")
        if rid in seen or rid in tree_ids:
            problems.append(f"{rid}: id is used twice (ids must not repeat the feature tree's)")
        seen.add(rid)
        if row.get("how") not in ROW_HOW:
            problems.append(f"{rid}: how must be one of {sorted(ROW_HOW)}, not {row.get('how')!r}")
        for field in ("name", "why", "source"):
            if not str(row.get(field) or "").strip():
                problems.append(f"{rid}: missing {field}")
    return problems


def slim(nodes) -> list[dict]:
    out = []
    for node in nodes or []:
        kept = {k: node[k] for k in NODE_FIELDS if k in node}
        if node.get("children"):
            kept["children"] = slim(node["children"])
        out.append(kept)
    return out


def page_data(tree: dict, pieces: dict) -> dict:
    return {"homes": tree.get("homes", {}), "tree": slim(tree["tree"]), "pieces": pieces}


def main(argv: list[str]) -> int:
    cmd = argv[1] if len(argv) > 1 else "check"
    tree = feature_tree.load()
    pieces = load_pieces()
    tree_ids = {node["id"] for node, _ in feature_tree.walk(tree["tree"])}
    found = feature_tree.problems(tree) + piece_problems(pieces, tree_ids)
    if found:
        print("architecture page: " + str(len(found)) + " problem(s)")
        for line in found:
            print("  " + line)
        return 1
    page = feature_tree.render(page_data(tree, pieces), TEMPLATE.read_text(encoding="utf-8"))
    rows = len(pieces["rows"])
    if cmd == "build":
        PAGE.write_text(page, encoding="utf-8")
        print(f"built {PAGE.relative_to(ROOT)}: {feature_tree.counts(tree)} plus {rows} laptop rows")
        return 0
    if cmd == "check":
        if not PAGE.exists() or PAGE.read_text(encoding="utf-8") != page:
            print(f"architecture page: {PAGE.relative_to(ROOT)} is out of date; run python3 scripts/architecture_page.py build")
            return 1
        print(f"architecture page ok: {feature_tree.counts(tree)} plus {rows} laptop rows")
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
