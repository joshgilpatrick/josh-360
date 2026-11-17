"""Tests for scripts/architecture_page.py and the JP-144 architecture page.

Each test named after a Gherkin scenario in JP-144 proves that scenario. Run: python3 -m unittest discover -s tests
"""
from __future__ import annotations

import json
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import architecture_page  # noqa: E402
import feature_tree  # noqa: E402

# Made-up sample rows, shaped like laptop-pieces.yaml.
SAMPLE = {
    "source": {"id": "HL", "name": "Sample", "about": "Sample source."},
    "rows": [
        {"id": "H1", "name": "Kept rule", "how": "as-is", "why": "Used every day.", "source": "JP-96"},
        {"id": "L1", "name": "Old memory", "how": "retire", "why": "The ledger replaces it.", "source": "JP-96"},
    ],
}


def embedded(page: str) -> dict:
    match = re.search(r"const DATA = (\{.*?\});\n", page, re.S)
    assert match, "no embedded data in the page"
    return json.loads(match.group(1).replace("<\\/", "</"))


class ACopyLivesInTheRepo(unittest.TestCase):
    def test_page_is_under_docs(self):
        self.assertTrue(architecture_page.PAGE.is_file())
        self.assertEqual(architecture_page.PAGE.relative_to(ROOT).parts[0], "docs")

    def test_built_page_is_up_to_date(self):
        tree = feature_tree.load()
        pieces = architecture_page.load_pieces()
        want = feature_tree.render(architecture_page.page_data(tree, pieces),
                                   architecture_page.TEMPLATE.read_text(encoding="utf-8"))
        self.assertEqual(architecture_page.PAGE.read_text(encoding="utf-8"), want,
                         "run python3 scripts/architecture_page.py build")


class TheSalvageMapCoversEveryFeature(unittest.TestCase):
    def test_every_tree_feature_and_laptop_row_is_in_the_page(self):
        data = embedded(architecture_page.PAGE.read_text(encoding="utf-8"))
        in_page = {n["id"] for n, _ in feature_tree.walk(data["tree"]) if n.get("call")}
        in_tree = {n["id"] for n, _ in feature_tree.walk(feature_tree.load()["tree"]) if n.get("call")}
        self.assertEqual(in_page, in_tree)
        rows = {r["id"] for r in data["pieces"]["rows"]}
        self.assertEqual(rows, {r["id"] for r in architecture_page.load_pieces()["rows"]})

    def test_the_page_carries_each_call(self):
        data = embedded(architecture_page.PAGE.read_text(encoding="utf-8"))
        tree = {n["id"]: n for n, _ in feature_tree.walk(feature_tree.load()["tree"]) if n.get("call")}
        for node, _ in feature_tree.walk(data["tree"]):
            if node.get("call"):
                self.assertEqual((node["call"], node["how"]), (tree[node["id"]]["call"], tree[node["id"]]["how"]))


class LaptopRows(unittest.TestCase):
    def test_sample_rows_pass(self):
        self.assertEqual(architecture_page.piece_problems(SAMPLE, {"X1"}), [])

    def test_unknown_how_is_refused(self):
        bad = {"source": SAMPLE["source"], "rows": [dict(SAMPLE["rows"][0], how="keep")]}
        self.assertTrue(any("how must be" in p for p in architecture_page.piece_problems(bad, set())))

    def test_id_that_repeats_the_tree_is_refused(self):
        self.assertTrue(any("used twice" in p for p in architecture_page.piece_problems(SAMPLE, {"H1"})))

    def test_row_without_a_reason_is_refused(self):
        bad = {"source": SAMPLE["source"], "rows": [dict(SAMPLE["rows"][0], why="")]}
        self.assertTrue(any("missing why" in p for p in architecture_page.piece_problems(bad, set())))

    def test_the_real_rows_pass(self):
        tree_ids = {n["id"] for n, _ in feature_tree.walk(feature_tree.load()["tree"])}
        self.assertEqual(architecture_page.piece_problems(architecture_page.load_pieces(), tree_ids), [])


if __name__ == "__main__":
    unittest.main()
