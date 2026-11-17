"""Tests for the duplicate rule gate of ticket-creation (JP-121). Made-up candidates.

Run: python3 -m unittest discover -s graphs/tests   (from the repository root)
"""
from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import ticket_creation_helpers as h


def candidate(key, status, is_match=True):
    return {"key": key, "summary": f"Ticket {key}", "status": status, "is_match": is_match, "why": "same words"}


class TheDuplicateRule(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def decide(self, candidates, weight="light"):
        record = dict(h.clone(h.RECORD), weight=weight)
        return h.run_gate("duplicate-rule", self.dir, {
            "candidates": candidates, "intake_record": h.write_json(self.dir / "record.json", record)})

    def test_an_open_match_is_found(self):
        _, out, _ = self.decide([candidate("AD-412", "In Progress")])
        self.assertEqual(out["outcome"], "open_match")
        self.assertEqual(out["outputs"]["match_key"], "AD-412")

    def test_a_done_match_gives_a_new_ticket_linked_to_it(self):
        _, out, _ = self.decide([candidate("AD-123", "Done")], "full")
        self.assertEqual((out["outcome"], out["outputs"]["match_key"], out["outputs"]["match_status"]),
                         ("new_full", "AD-123", "Done"))

    def test_a_cancelled_match_is_linked_too(self):
        self.assertEqual(self.decide([candidate("AD-9", "Cancelled")])[1]["outcome"], "new_light")

    def test_a_non_match_is_ignored_even_when_open(self):
        _, out, _ = self.decide([candidate("AD-1", "In Progress", is_match=False)])
        self.assertEqual((out["outcome"], out["outputs"]["match_key"]), ("new_light", "none"))

    def test_the_first_open_match_beats_a_finished_one_listed_before_it(self):
        _, out, _ = self.decide([candidate("AD-5", "Done"), candidate("AD-6", "To Do")])
        self.assertEqual((out["outcome"], out["outputs"]["match_key"]), ("open_match", "AD-6"))

    def test_an_empty_list_follows_the_weight(self):
        self.assertEqual(self.decide([], "full")[1]["outcome"], "new_full")
        self.assertEqual(self.decide([], "light")[1]["outcome"], "new_light")

    def test_a_malformed_list_stops_the_run_and_is_never_read_as_no_match(self):
        code, out, err = self.decide([{"key": "AD-1"}])
        self.assertEqual((code, out), (1, None))
        self.assertIn("is_match", err)
        self.assertEqual(self.decide("not a list")[0], 1)


if __name__ == "__main__":
    unittest.main()
