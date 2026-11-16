"""The suite's inventory check (scripts/check.py, check 6) for JP-96's "Every item has a verdict" scenario."""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import check  # noqa: E402

HEADER = "| Item | What it is | Started by | Reads and writes | Last used | Verdict | Reason |\n| --- | --- | --- | --- | --- | --- | --- |\n"


def problems_for(text: str) -> list[str]:
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "inv.md"
        path.write_text(text, encoding="utf-8")
        return check.inventory_problems(path)


class InventoryCheckTest(unittest.TestCase):
    def test_good_row_passes(self):
        self.assertEqual(problems_for(HEADER + "| a | b | c | d | e | keep | A reason of some length. |\n"), [])

    def test_two_verdicts_fail(self):
        self.assertTrue(problems_for(HEADER + "| a | b | c | d | e | keep or migrate | A reason of some length. |\n"))

    def test_unknown_verdict_fails(self):
        self.assertTrue(problems_for(HEADER + "| a | b | c | d | e | retire | A reason of some length. |\n"))

    def test_missing_reason_fails(self):
        self.assertTrue(problems_for(HEADER + "| a | b | c | d | e | dismantle |  |\n"))

    def test_item_table_without_verdict_column_fails(self):
        head = "| Item | What it is |\n| --- | --- |\n"
        self.assertTrue(problems_for(head + "| a | b |\n"))

    def test_figure_needs_range_and_command(self):
        head = "| Figure | Value | Date range | Produced by |\n| --- | --- | --- | --- |\n"
        self.assertEqual(problems_for(head + "| x | 1 | 2026-11-16 | `gh api` |\n"), [])
        self.assertTrue(problems_for(head + "| x | 1 |  | `gh api` |\n"))

    def test_repo_inventory_passes(self):
        for doc in sorted((ROOT / "docs/inventory").glob("*.md")):
            self.assertEqual(check.inventory_problems(doc), [], doc.name)


if __name__ == "__main__":
    unittest.main()
