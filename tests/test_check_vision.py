"""The suite's vision check (scripts/check.py): nothing Proposed, and every graph built in phase 1 (JP-147)."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import check  # noqa: E402


class VisionCheckTest(unittest.TestCase):
    def test_graph_built_in_phase_1_passes(self):
        self.assertEqual(check.vision_problems("| Triage | x | y | Designed in phase 1 (JP-103), built in phase 1 (JP-122) |\n"), [])

    def test_graph_built_in_phase_2_fails(self):
        problems = check.vision_problems("| Triage | x | y | Designed in phase 1, built in phase 2 |\n")
        self.assertEqual(len(problems), 1)
        self.assertIn("JP-147", problems[0])

    def test_proposed_marker_still_fails(self):
        self.assertEqual(len(check.vision_problems("Proposed: something\n")), 1)

    def test_real_vision_passes(self):
        text = (ROOT / "docs/vision-and-roadmap.md").read_text(encoding="utf-8")
        self.assertEqual(check.vision_problems(text), [])


if __name__ == "__main__":
    unittest.main()
