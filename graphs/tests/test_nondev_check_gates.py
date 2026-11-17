"""JP-123, Task 3: check-deliverable, pick-path and check-review. Made-up files and tickets only."""
import os
import unittest

from nondev_helpers import DESCRIPTION, KEY, Case, FakeTicket, gate, write_artifacts
from lib.gate_run import GateError

CHECK = gate("check-deliverable")
PICK = gate("pick-path")
REVIEW = gate("check-review")


class CheckDeliverable(Case):
    def check(self, deliverable, evidence, **extra):
        inputs = {"ticket_key": KEY, "phi": "false", "deliverable_path": str(deliverable), "evidence_path": str(evidence)}
        inputs.update(extra)
        return CHECK.run(inputs, self.deps())

    def test_complete_deliverable(self):
        deliverable, evidence = write_artifacts(self.root)
        self.assertEqual(self.check(deliverable, evidence)[0], "complete")

    def test_dotdot_path_is_incomplete(self):
        deliverable, evidence = write_artifacts(self.root)
        sneaky = str(deliverable.parent / ".." / "widgets" / deliverable.name)
        outcome, _, summary = self.check(sneaky, evidence)
        self.assertEqual(outcome, "incomplete")
        self.assertIn("'..'", summary)

    def test_relative_and_missing_paths_are_incomplete(self):
        _, evidence = write_artifacts(self.root)
        self.assertEqual(self.check("JP-9001-answer.md", evidence)[0], "incomplete")
        self.assertEqual(self.check(self.root / "artifacts" / "widgets" / "JP-9001-gone.md", evidence)[0], "incomplete")

    def test_tilde_is_expanded(self):
        deliverable, evidence = write_artifacts(self.root)
        os.environ["HOME"] = str(self.root)
        self.addCleanup(os.environ.pop, "HOME", None)
        # ~/artifacts/widgets/... is the same file once expanded
        self.assertEqual(self.check("~/artifacts/widgets/" + deliverable.name, evidence)[0], "complete")

    def test_symlink_into_repo_is_incomplete(self):
        _, evidence = write_artifacts(self.root)
        repo = self.root / "repo"
        (repo / ".git").mkdir(parents=True)
        (repo / "JP-9001-answer.md").write_text("x")
        link = self.root / "artifacts" / "widgets" / "JP-9001-link.md"
        link.symlink_to(repo / "JP-9001-answer.md")
        outcome, _, summary = self.check(link, evidence)
        self.assertEqual(outcome, "incomplete")
        self.assertIn("not directly inside", summary)

    def test_folder_that_is_a_repository_is_incomplete(self):
        deliverable, evidence = write_artifacts(self.root)
        (deliverable.parent / ".git").mkdir()
        self.assertIn("repository", self.check(deliverable, evidence)[2])

    def test_worktree_path_is_incomplete(self):
        # a root that itself sits in a worktree folder
        inner = self.root / "w" / ".claude" / "worktrees" / "x"
        (inner / "artifacts" / "widgets").mkdir(parents=True)
        file = inner / "artifacts" / "widgets" / "JP-9001-answer.md"
        file.write_text("x")
        deps = self.deps(artifacts_root=inner / "artifacts")
        inputs = {"ticket_key": KEY, "phi": "false", "deliverable_path": str(file), "evidence_path": str(file)}
        self.assertIn("worktree", CHECK.run(inputs, deps)[2])

    def test_file_straight_in_the_root_is_incomplete(self):
        deliverable, evidence = write_artifacts(self.root)
        stray = self.root / "artifacts" / "JP-9001-answer.md"
        stray.write_text("x")
        self.assertEqual(self.check(stray, evidence)[0], "incomplete")

    def test_key_prefix_required(self):
        deliverable, evidence = write_artifacts(self.root)
        wrong = deliverable.parent / "answer.md"
        wrong.write_text("x")
        self.assertIn("ticket key", self.check(wrong, evidence)[2])

    def test_no_sources_is_incomplete(self):
        deliverable, evidence = write_artifacts(self.root)
        text = evidence.read_text()
        start = text.index("sources:")
        end = text.index("assumptions:")
        evidence.write_text(text[:start] + "sources: []\n" + text[end:])
        self.assertIn("no source", self.check(deliverable, evidence)[2])

    def test_missing_query_file_is_incomplete(self):
        deliverable, evidence = write_artifacts(self.root, queries=False)
        self.assertIn("saved query", self.check(deliverable, evidence)[2])

    def test_evidence_naming_another_ticket_is_incomplete(self):
        deliverable, evidence = write_artifacts(self.root)
        evidence.write_text(evidence.read_text().replace("ticket: JP-9001", "ticket: JP-9002", 1))
        self.assertIn("different ticket", self.check(deliverable, evidence)[2])

    def test_unreadable_evidence_is_incomplete_without_quoting_it(self):
        deliverable, evidence = write_artifacts(self.root)
        evidence.write_text("no front block here, only a secret SSN 123-45-6789")
        outcome, _, summary = self.check(deliverable, evidence)
        self.assertEqual(outcome, "incomplete")
        self.assertNotIn("123-45", summary)

    def test_missing_input_stops_the_run(self):
        with self.assertRaises(GateError):
            CHECK.run({"phi": "false"}, self.deps())


class PickPath(Case):
    def pick(self, precedent, kind="research", comments=()):
        deps = self.deps(ticket=FakeTicket(comments=list(comments)))
        return PICK.run({"ticket_key": KEY, "kind": kind, "precedent": precedent, "evidence_path": "x"}, deps)[0]

    def test_short_for_precedent(self):
        self.assertEqual(self.pick("JP-9000"), "short")

    def test_short_for_misc(self):
        self.assertEqual(self.pick("none", kind="misc"), "short")
        self.assertEqual(self.pick(None, kind="misc"), "short")

    def test_full_otherwise(self):
        self.assertEqual(self.pick("none"), "full")
        self.assertEqual(self.pick(None, kind="doc"), "full")

    def test_full_after_earlier_delivery_comment(self):
        self.assertEqual(self.pick("JP-9000", comments=["Deliverable ready | x | next gate: Josh's sign-off"]), "full")

    def test_full_after_reopen_resolution_comment(self):
        self.assertEqual(self.pick("none", kind="misc", comments=["Resolution: q | a | sources: s | next gate: none"]), "full")

    def test_other_comments_do_not_force_full(self):
        self.assertEqual(self.pick("JP-9000", comments=["go", "Josh's answer: use the staging copy"]), "short")


class CheckReview(Case):
    def review(self, findings, text=DESCRIPTION):
        deliverable, evidence = write_artifacts(self.root)
        deps = self.deps(ticket=FakeTicket(description=text))
        import json
        inputs = {"ticket_key": KEY, "findings": json.dumps(findings), "evidence_path": str(evidence)}
        return REVIEW.run(inputs, deps), evidence.parent / "JP-9001-feedback.md"

    def finding(self, quote, **more):
        return dict({"quote": quote, "where": "Heading", "problem": "wrong", "fix": "right"}, **more)

    def test_finding_kept_across_line_breaks(self):
        text = DESCRIPTION.replace("filed last quarter, and how many", "filed last quarter,\n  and how many")
        (outcome, _, _), feedback = self.review(
            [self.finding("open widgets were filed last quarter, and how many were closed")], text)
        self.assertEqual(outcome, "rework")
        self.assertIn('"open widgets were filed last quarter', feedback.read_text())

    def test_unquoted_finding_dropped(self):
        (outcome, _, summary), feedback = self.review([self.finding("a line the ticket never had")])
        self.assertEqual((outcome, summary), ("clean", "0 of 1 findings kept"))
        self.assertFalse(feedback.exists())

    def test_quote_marks_around_the_quote_do_not_matter(self):
        (outcome, _, _), _ = self.review([self.finding('"a one-page Markdown note with the two counts"')])
        self.assertEqual(outcome, "rework")

    def test_quote_of_other_sections_is_dropped(self):
        (outcome, _, _), _ = self.review([self.finding("Josh wants the trend.")])   # the Why section
        self.assertEqual(outcome, "clean")

    def test_feedback_file_written(self):
        (_, _, _), feedback = self.review([self.finding("the two counts", problem="has a \"quote\"")])
        text = feedback.read_text()
        self.assertTrue(text.startswith("# Feedback for JP-9001"))
        self.assertIn('- quote: "the two counts"', text)
        self.assertIn('problem: "has a \\"quote\\""', text)

    def test_old_feedback_is_emptied_when_clean(self):
        deliverable, evidence = write_artifacts(self.root)
        old = evidence.parent / "JP-9001-feedback.md"
        old.write_text("old defects")
        import json
        deps = self.deps()
        REVIEW.run({"ticket_key": KEY, "findings": json.dumps([]), "evidence_path": str(evidence)}, deps)
        self.assertIn("[]", old.read_text())
        self.assertNotIn("old defects", old.read_text())

    def test_findings_that_are_not_a_list_stop_the_run(self):
        deliverable, evidence = write_artifacts(self.root)
        with self.assertRaises(GateError):
            REVIEW.run({"ticket_key": KEY, "findings": "not json", "evidence_path": str(evidence)}, self.deps())

    def test_no_findings_input_is_clean(self):
        deliverable, evidence = write_artifacts(self.root)
        out = REVIEW.run({"ticket_key": KEY, "findings": None, "evidence_path": str(evidence)}, self.deps())
        self.assertEqual(out[0], "clean")


if __name__ == "__main__":
    unittest.main()
