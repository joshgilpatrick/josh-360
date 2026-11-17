"""JP-123, Task 2: read-ticket and gap-check. Made-up tickets only."""
import unittest

from nondev_helpers import DESCRIPTION, KEY, Case, FakeTicket, gate

READ = gate("read-ticket")
GAP = gate("gap-check")
INPUTS = {"ticket_key": KEY, "kind": "research", "system": "widgets", "phi": "false"}


class ReadTicket(Case):
    def read(self, ticket, **inputs):
        return READ.run(dict(INPUTS, **inputs), self.deps(ticket=ticket))

    def test_workable_ticket(self):
        outcome, outputs, _ = self.read(FakeTicket())
        self.assertEqual(outcome, "workable")
        self.assertTrue(outputs["deliverable_given"])
        self.assertIn("widgets", outputs["search_terms"])
        self.assertIn("ordering", outputs["search_terms"])       # from the registry description
        self.assertNotIn("how", outputs["search_terms"])         # under four letters

    def test_ad_key_is_not_here(self):
        outcome, outputs, _ = READ.run(dict(INPUTS, ticket_key="AD-12"), self.deps())
        self.assertEqual((outcome, outputs["reason"]), ("not_here", "the ticket is not in JP"))

    def test_status_must_be_ready(self):
        outcome, outputs, _ = self.read(FakeTicket(status="Not Started"))
        self.assertEqual((outcome, outputs["reason"]), ("not_here", "the ticket is not Ready"))

    def test_missing_route_is_not_here(self):
        ticket = FakeTicket()
        ticket.tickets[KEY] = ticket.tickets[KEY]._replace(route=None)
        self.assertEqual(self.read(ticket)[0], "not_here")

    def test_route_development_is_not_here(self):
        self.assertEqual(self.read(FakeTicket(route={"graph": "development"}))[0], "not_here")

    def test_empty_deliverable_section_is_not_here(self):
        text = DESCRIPTION.replace("a one-page Markdown note with the two counts", "")
        outcome, outputs, _ = self.read(FakeTicket(description=text))
        self.assertEqual(outcome, "not_here")
        self.assertIn("Deliverable format", outputs["reason"])

    def test_missing_question_section_is_not_here(self):
        text = DESCRIPTION.replace("**Question:**", "**Query:**")
        self.assertEqual(self.read(FakeTicket(description=text))[0], "not_here")

    def test_jira_read_failure_is_not_here(self):
        outcome, outputs, _ = self.read(FakeTicket(fail_on=["read"]))
        self.assertEqual((outcome, outputs["reason"]), ("not_here", "the ticket could not be read"))

    def test_inferred_marker_sets_deliverable_given_false(self):
        text = DESCRIPTION.replace("with the two counts", "with the two counts (inferred)")
        outcome, outputs, _ = self.read(FakeTicket(description=text))
        self.assertEqual((outcome, outputs["deliverable_given"]), ("workable", False))

    def test_headings_in_other_styles_still_read(self):
        text = "## Question\nWhat is x?\n\n## Sources\nthe file\n\nDeliverable format:\na note\n"
        self.assertEqual(self.read(FakeTicket(description=text))[0], "workable")

    def test_unlisted_system_adds_no_registry_words(self):
        _, outputs, _ = self.read(FakeTicket(), system="unlisted")
        self.assertNotIn("ordering", outputs["search_terms"])


class GapCheck(Case):
    def gap(self, precedent, given, ticket=None):
        inputs = {"ticket_key": KEY, "kind": "research", "deliverable_given": given, "precedent": precedent}
        return GAP.run(inputs, self.deps(ticket=ticket or FakeTicket(
            description=DESCRIPTION.replace("with the two counts", "with the two counts (inferred)"))))

    def test_gap_only_without_precedent_and_inferred(self):
        self.assertEqual(self.gap("none", "false")[0], "gap")
        self.assertEqual(self.gap("JP-9000", "false")[0], "clear")   # a precedent: no ping
        self.assertEqual(self.gap("none", "true")[0], "clear")       # Josh gave the format: no ping
        self.assertEqual(self.gap("JP-9000", "true")[0], "clear")

    def test_missing_precedent_counts_as_none(self):
        self.assertEqual(self.gap(None, "false")[0], "gap")

    def test_gap_text_matches_spec_copy(self):
        _, outputs, _ = self.gap("none", "false")
        self.assertEqual(outputs["gap"], outputs["card"])
        self.assertEqual(
            outputs["gap"],
            'JP-9001: before I start. Question: How many open widgets were filed last quarter, and how many were closed '
            'within a week? I\'ll deliver a one-page Markdown note with the two counts, assuming that format fits, since '
            'the ticket did not give one (I worked it out from the kind of work: research). Is that right? '
            'One sentence is enough, or reply "go".')

    def test_clear_makes_no_jira_read(self):
        ticket = FakeTicket(fail_on=["read"])
        self.assertEqual(self.gap("JP-9000", "false", ticket)[0], "clear")


if __name__ == "__main__":
    unittest.main()
