"""Tests for the completeness gate of ticket-creation (JP-121). Every text is made up.

Run: python3 -m unittest discover -s graphs/tests   (from the repository root)
"""
from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import ticket_creation_helpers as h


class TheCompletenessGate(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        h.action_items(self.dir, h.todo())

    def check(self, proposal, **extra):
        inputs = {"proposal": h.write_json(self.dir / "proposal.json", proposal), "source": "todo",
                  "source_ref": "todo-0007", "intake_record": h.write_json(self.dir / "record.json", h.RECORD),
                  "route": proposal.get("route", {}), "candidates": []}
        inputs.update(extra)
        code, out, err = h.run_gate("ticket-complete", self.dir, inputs)
        self.assertEqual(code, 0, err)
        return out

    def test_a_complete_single_ticket_passes_with_a_card(self):
        out = self.check(h.proposal())
        self.assertEqual(out["outcome"], "pass")
        self.assertIn("New ticket from a to-do", out["outputs"]["card"])

    def test_a_missing_section_is_fixable(self):
        bad = h.proposal(tickets=[h.ticket(sections=h.section_set(why=""))])
        out = self.check(bad)
        self.assertEqual(out["outcome"], "fixable")
        self.assertIn("t1: Why is empty", out["outputs"]["problems"])

    def test_a_gap_is_needs_josh(self):
        out = self.check(h.proposal(gaps=["What does done look like for the export?"]))
        self.assertEqual(out["outcome"], "needs_josh")
        self.assertIn("What does done look like", out["outputs"]["card"])

    def test_an_unclear_type_and_an_unclear_work_kind_are_needs_josh(self):
        self.assertEqual(self.check(h.proposal(tickets=[h.ticket(type="unclear")]))["outcome"], "needs_josh")
        self.assertEqual(self.check(h.proposal(tickets=[h.ticket(work_kind="unclear")]))["outcome"], "needs_josh")

    def test_no_parent_and_no_area_is_needs_josh(self):
        route = dict(h.proposal()["route"], parent=None, area=None, system=None, labels=[], rule="fallback")
        out = self.check(h.proposal(route=route))
        self.assertEqual(out["outcome"], "needs_josh")
        self.assertIn("epic or area", out["outputs"]["problems"][0])

    def test_a_label_whose_system_has_an_area_counts_as_a_home(self):
        route = dict(h.proposal()["route"], parent=None, area=None, labels=["pims-services"])
        self.assertEqual(self.check(h.proposal(route=route))["outcome"], "pass")

    def test_ordinary_shared_words_with_a_harmless_source_are_not_a_copy(self):
        self.assertEqual(self.check(h.proposal())["outcome"], "pass")

    def test_a_verbatim_run_of_a_patient_data_source_is_blocked_and_never_quoted(self):
        quoted = h.SOURCE_TEXT[10:60]
        bad = h.proposal(tickets=[h.ticket(sections=h.section_set(why=f"Josh said: {quoted}"))])
        flagged = dict(h.clone(h.RECORD), contains_patient_data=True)
        out = self.check(bad, intake_record=h.write_json(self.dir / "flagged.json", flagged))
        self.assertEqual(out["outcome"], "fixable")
        self.assertIn("t1.why: copied-source", out["outputs"]["problems"])
        self.assertNotIn(quoted, str(out))

    def test_a_labelled_record_number_is_blocked(self):
        bad = h.proposal(tickets=[h.ticket(sections=h.section_set(why="Fix the chart for MRN 1234567"))])
        out = self.check(bad)
        self.assertEqual(out["outcome"], "fixable")
        self.assertIn("t1.why: labelled-id", out["outputs"]["problems"])
        self.assertNotIn("1234567", str(out))

    def test_a_long_summary_and_a_summary_with_a_line_break_are_fixable(self):
        long = h.proposal(tickets=[h.ticket(summary="x" * 256)])
        self.assertIn("summary is 256 characters", " ".join(self.check(long)["outputs"]["problems"]))
        broken = h.proposal(tickets=[h.ticket(summary="one\ntwo")])
        self.assertIn("line break", " ".join(self.check(broken)["outputs"]["problems"]))

    def test_the_gherkin_block_is_required(self):
        bad = h.proposal(tickets=[h.ticket(sections=h.section_set(acceptance_criteria="It should work."))])
        self.assertIn("Gherkin", " ".join(self.check(bad)["outputs"]["problems"]))

    def test_each_type_has_its_own_sections(self):
        bug = h.proposal(tickets=[h.ticket(type="Bug")])
        self.assertIn("t1: Current behaviour is empty", self.check(bug)["outputs"]["problems"])
        research = h.proposal(tickets=[h.ticket(type="Research")])
        self.assertIn("t1: Question is empty", self.check(research)["outputs"]["problems"])

    def test_an_epic_with_children_passes(self):
        self.assertEqual(self.check(h.family())["outcome"], "pass")

    def test_a_comment_on_an_open_match_passes_without_tickets(self):
        comment = {"action": "comment_on_match", "match": {"key": "AD-412", "status": "In Progress",
                                                           "request": "Add a dry-run flag."}, "gaps": [], "authors": []}
        out = self.check(comment)
        self.assertEqual(out["outcome"], "pass")
        self.assertIn("Already open: AD-412", out["outputs"]["card"])

    def test_a_proposal_that_is_not_well_formed_is_fixable(self):
        out = self.check({"action": "create"})
        self.assertEqual(out["outcome"], "fixable")


if __name__ == "__main__":
    unittest.main()
