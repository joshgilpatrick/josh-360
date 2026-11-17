"""Golden tests for the approval card text (JP-121). Each expected text is the block in
docs/design/ticket-creation-graph.md, "The approval card", without the button row (the Needs you tab draws the buttons).

Run: python3 -m unittest discover -s graphs/tests   (from the repository root)
"""
from __future__ import annotations

import unittest

import ticket_creation_helpers as h
from lib import card

ONE = """New ticket from a to-do: Add a dry-run flag to the laptop install script

Create in JP under JP-94 (josh-360, by its repository)
Story · code · light · runs in a cloud session (inferred)
Goal: laptop/install.py --dry-run prints every step it would take and changes nothing.
1 scenario. Inferred: first step, where it runs.
Duplicates: none (searched JP, AD, CI for "dry run", "install preview", "install.py flag").
Full text: <link to the proposal>"""

MANY = """New tickets from an email: Move the survey export to the new pipeline

Create in AD: 1 epic and 3 tickets (survey-services, by its repository; area: Clinical application platform)
Epic: Move the survey export to the new pipeline. Done when: the old export job is off.
Branch strategy: one branch per ticket.
  1. Task: Build the new export step. Delivers the export.
  2. Task: Backfill the last 90 days. Delivers the history. Blocked by 1.
  3. Task: Switch off the old job. Delivers the switch-off. Blocked by 2.
Related: AD-123 (Done), linked with Relates.
Inferred: the epic's done when, branch strategy.
Full text: <link to the proposal>"""

OPEN = """Already open: AD-412, "Survey export misses Saturday rows" (In Progress)

Add a comment to AD-412 with this request, and stop?
Matched on "survey export", "missing rows"."""


class TheApprovalCard(unittest.TestCase):
    def test_one_ticket(self):
        text = card.render(h.proposal(), [], "<link to the proposal>", source="todo", weight="light",
                           search_terms=h.RECORD["search_terms"])
        self.assertEqual(text, ONE)

    def test_a_parent_with_children(self):
        proposal = h.family()
        proposal["match"] = {"key": "AD-123", "status": "Done"}
        text = card.render(proposal, [], "<link to the proposal>", source="email")
        self.assertEqual(text, MANY)

    def test_an_open_match(self):
        proposal = {"action": "comment_on_match", "gaps": [], "authors": [],
                    "match": {"key": "AD-412", "status": "In Progress", "request": "The export drops rows."}}
        candidates = [{"key": "AD-412", "summary": "Survey export misses Saturday rows", "status": "In Progress",
                       "is_match": True, "why": '"survey export", "missing rows"'}]
        self.assertEqual(card.render(proposal, candidates, "<link>", source="email"), OPEN)

    def test_stage_two_adds_the_suggestion_heading(self):
        text = card.render(h.proposal(), [], "<link to the proposal>", source="todo",
                           precedent={"decision": "D-14", "date": "2026-11-20", "category": "ticket-creation/approve;system=josh-360"})
        self.assertTrue(text.startswith("Suggested: approve, as you did for D-14 on 2026-11-20 "
                                        "(ticket-creation/approve;system=josh-360)\n\nNew ticket from a to-do"))

    def test_the_stage_three_comment_text(self):
        self.assertEqual(card.stage3_comment("D-14", "ticket-creation/approve;system=josh-360"),
                         "Created without asking, under decision D-14 (ticket-creation/approve;system=josh-360). "
                         "Cancel this ticket to overrule it.")

    def test_the_inferred_list_names_each_field(self):
        proposal = h.proposal(inferred=["t1.first_step", "t1.where_it_runs", "t1.why"])
        text = card.render(proposal, [], "<link>", source="todo", weight="light")
        self.assertIn("Inferred: first step, why, where it runs.", text)


if __name__ == "__main__":
    unittest.main()
