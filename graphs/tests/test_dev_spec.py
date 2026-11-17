"""JP-115, Task 6: the spec file, the five comments, question-route and lint-spec. Made-up specs and tickets only."""
import json
import unittest
from pathlib import Path

from dev_helpers import DESCRIPTION, KEY, SPEC, Case, FakeTicket, gate, make_deps, spec_copy, write_spec
from lib import dev_copy, dev_spec, feedback
from lib.gate_run import GateError

LINT = gate("lint-spec")
ROUTE = gate("question-route")
REVIEW = gate("check-review")
NAMES = dev_spec.scenario_names(DESCRIPTION)


class SpecFile(Case):
    def test_load_reads_json_form(self):
        path = write_spec(self.root / "work")
        self.assertEqual(dev_spec.load(path)["ticket"], KEY)

    def test_load_refuses_block_yaml(self):
        path = self.root / "spec.yaml"
        path.write_text("ticket: JP-1\nphases:\n  - id: p1\n")
        with self.assertRaises(dev_spec.SpecError):
            dev_spec.load(path)
        path.write_text("[1, 2]")
        with self.assertRaises(dev_spec.SpecError):
            dev_spec.load(path)

    def test_scenario_names(self):
        self.assertEqual(NAMES, ["A widget is labelled", "The label reads well on a real screen"])
        text = "Scenario Outline:   Many   widgets \nScenario: One"
        self.assertEqual(dev_spec.scenario_names(text), ["Many widgets", "One"])

    def test_sample_spec_has_no_problems(self):
        self.assertEqual(dev_spec.problems(SPEC, NAMES), [])

    def problem(self, spec, text):
        found = dev_spec.problems(spec, NAMES)
        self.assertTrue(any(text in p for p in found), "{!r} not in {}".format(text, found))

    def test_ticket_and_summary_missing(self):
        self.problem(spec_copy(ticket=""), "ticket")
        self.problem(spec_copy(summary=" "), "summary")

    def test_no_definition_of_done(self):
        self.problem(spec_copy(definition_of_done=[]), "definition_of_done")
        self.problem(spec_copy(definition_of_done=[{"id": "done-1", "rule": "x"}]), "definition_of_done")
        self.problem(spec_copy(definition_of_done=[{"id": "DOD-1", "rule": ""}]), "definition_of_done")

    def test_no_phase(self):
        self.problem(spec_copy(phases=[]), "no phase")

    def test_bad_or_repeated_phase_id(self):
        spec = spec_copy()
        spec["phases"][0]["id"] = "P 1"
        self.problem(spec, "id")
        spec = spec_copy()
        spec["phases"][1]["id"] = "p1"
        self.problem(spec, "more than once")

    def test_phase_without_task_checks_or_files(self):
        for field, text in (("task", "task"), ("checks", "check"), ("files", "files")):
            spec = spec_copy()
            spec["phases"][0][field] = []
            if field == "files":
                del spec["phases"][0][field]
            self.problem(spec, text)

    def test_missing_scenario(self):
        spec = spec_copy(scenarios=[SPEC["scenarios"][0]])
        self.problem(spec, "The label reads well on a real screen")

    def test_scenario_names_compare_whitespace_collapsed_and_case_folded(self):
        spec = spec_copy()
        spec["scenarios"][0]["name"] = "a  WIDGET is labelled"
        self.assertEqual(dev_spec.problems(spec, NAMES), [])

    def test_scenario_tag_and_proof(self):
        spec = spec_copy()
        spec["scenarios"][1]["tag"] = "@maybe"
        self.problem(spec, "tag")
        spec = spec_copy()
        spec["scenarios"][1]["proved_by"] = ""
        self.problem(spec, "proved_by")

    def test_auto_scenario_must_name_a_check(self):
        spec = spec_copy()
        spec["scenarios"][0]["proved_by"] = "p2.check.7"
        self.problem(spec, "A widget is labelled")
        spec["scenarios"][0]["proved_by"] = "some proof file"
        self.problem(spec, "A widget is labelled")

    def test_criterion_text_resolves_three_forms(self):
        self.assertTrue(dev_spec.criterion_text(SPEC, "DOD-2").startswith("Every item"))
        self.assertEqual(dev_spec.criterion_text(SPEC, "p1.task.2"), "Put the word widget in it")
        self.assertEqual(dev_spec.criterion_text(SPEC, "p2.check.1"), "grep -q label widget.txt")

    def test_criterion_out_of_range_is_none(self):
        for criterion in ("DOD-9", "p1.task.3", "p1.task.0", "p3.check.1", "p1.check.x", "nonsense", "p1.file.1"):
            with self.subTest(criterion):
                self.assertIsNone(dev_spec.criterion_text(SPEC, criterion))

    def test_spec_text_holds_every_string_value(self):
        text = dev_spec.spec_text(SPEC)
        self.assertIn("Put the word widget in it", text.splitlines())
        self.assertIn("grep -q label widget.txt", text.splitlines())

    def test_state_missing_file_loads_empty(self):
        self.assertEqual(dev_spec.load_state(self.root), {"review_round": 0, "phases": {}})

    def test_state_round_trips(self):
        state = {"review_round": 1, "phases": {"p1": {"status": "passed", "attempts": 2, "extra_checks": ["true"]}}}
        dev_spec.save_state(self.root, state)
        self.assertEqual(dev_spec.load_state(self.root), state)


class Copy(unittest.TestCase):
    def test_copy_matches_the_spec(self):
        self.assertEqual(dev_copy.pr_opened("https://x/pr/1", 3, 4, "abc1234"),
                         "Pull request opened | https://x/pr/1 · checks 3/4 on abc1234 | next gate: the PR audit")
        self.assertEqual(
            dev_copy.returned_question("Which colour?", "/w/question.md", "r-1"),
            "Returned to triage | the designer needs: Which colour? · run r-1, spec saved | "
            "next gate: triage answers it, then this run resumes")
        self.assertEqual(
            dev_copy.returned_question(None, "/w/question.md", "r-1"),
            "Returned to triage | the designer needs: withheld: patient data, see /w/question.md · run r-1, "
            "spec saved | next gate: triage answers it, then this run resumes")
        self.assertEqual(
            dev_copy.fixes_pushed(2, "Fixed both.", "ready for human"),
            "Review fixes pushed (2 finding(s) addressed) | Fixed both. | next gate: ready for human" + dev_copy.FOOTER)
        self.assertEqual(dev_copy.done_merged("https://x/pr/1", "abc1234", "r-1", False),
                         "Done | merged https://x/pr/1 as abc1234 · spec and evidence saved with run r-1 | next gate: none")
        self.assertEqual(dev_copy.done_merged("https://x/pr/1", "abc1234", "r-1", True),
                         "Done | merged https://x/pr/1 as abc1234 · design and plan merged with it, run r-1 | "
                         "next gate: none")
        self.assertEqual(
            dev_copy.cancelled("https://x/pr/1", "r-1"),
            "Cancelled | https://x/pr/1 was closed without merging · spec and evidence saved with run r-1 | "
            "next gate: Josh reopens the ticket if he wants it built again")
        self.assertEqual(dev_copy.FOOTER, "\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_")


class QuestionRoute(Case):
    def test_question_route(self):
        self.assertEqual(ROUTE.run({"ticket_type": "Research"}, self.deps())[0], "to_josh")
        for kind in ("Story", "Bug", "Task"):
            self.assertEqual(ROUTE.run({"ticket_type": kind}, self.deps())[0], "to_triage")


class LintSpec(Case):
    def setUp(self):
        super().setUp()
        self.clone = self.root / "widgets"
        self.worktree = self.clone / ".claude" / "worktrees" / "JP-9002-label"
        self.worktree.mkdir(parents=True)
        self.work = self.root / "runs" / "r-1" / "work"
        self.work.mkdir(parents=True)

    def lint(self, spec_path=None, ticket_type="Story", work_dir=None, own=None, plan_path="none", description=DESCRIPTION):
        deps = self.deps(ticket=FakeTicket(description=description, key=KEY), work_dir=own or self.work)
        inputs = {"ticket_key": KEY, "ticket_type": ticket_type, "spec_path": str(spec_path or self.work / "spec.yaml"),
                  "plan_path": plan_path, "worktree": str(self.worktree), "work_dir": str(work_dir or self.work)}
        return LINT.run(inputs, deps)

    def test_lint_complete(self):
        write_spec(self.work)
        outcome, _, summary = self.lint()
        self.assertEqual(outcome, "complete", summary)

    def test_lint_refuses_spec_inside_a_worktree(self):
        path = write_spec(self.worktree)
        outcome, _, summary = self.lint(spec_path=path)
        self.assertEqual(outcome, "incomplete")
        self.assertTrue((self.work / "lint.md").is_file())
        self.assertIn("work folder", (self.work / "lint.md").read_text())

    def test_lint_refuses_a_work_folder_inside_the_clone(self):
        inside = self.clone / "notes" / "work"
        write_spec(inside)
        with self.assertRaises(GateError):
            self.lint(spec_path=inside / "spec.yaml", work_dir=inside, own=inside)

    def test_lint_refuses_a_work_folder_inside_the_worktree(self):
        inside = self.worktree / "work"
        write_spec(inside)
        with self.assertRaises(GateError):
            self.lint(spec_path=inside / "spec.yaml", work_dir=inside, own=inside)

    def test_lint_refuses_a_work_folder_that_is_not_the_runs(self):
        other = self.root / "elsewhere" / "work"
        write_spec(other)
        with self.assertRaises(GateError):
            self.lint(spec_path=other / "spec.yaml", work_dir=other)

    def test_lint_incomplete_writes_lint_md(self):
        write_spec(self.work, spec_copy(phases=[]))
        outcome, _, summary = self.lint()
        self.assertEqual(outcome, "incomplete")
        text = (self.work / "lint.md").read_text()
        self.assertIn("no phase", text)
        self.assertNotIn("no phase", summary)
        self.assertRegex(summary, r"\d+ problem")

    def test_lint_missing_or_unreadable_spec_is_incomplete(self):
        outcome, _, _ = self.lint()
        self.assertEqual(outcome, "incomplete")
        (self.work / "spec.yaml").write_text("ticket: x\n")
        self.assertEqual(self.lint()[0], "incomplete")

    def test_lint_complete_removes_lint_md(self):
        (self.work / "lint.md").write_text("old problem\n")
        write_spec(self.work)
        self.assertEqual(self.lint()[0], "complete")
        self.assertFalse((self.work / "lint.md").exists())

    def test_lint_scenario_names_come_from_the_ticket(self):
        write_spec(self.work)
        outcome, _, _ = self.lint(description=DESCRIPTION + "\n  Scenario: Another one\n")
        self.assertEqual(outcome, "incomplete")
        self.assertIn("Another one", (self.work / "lint.md").read_text())

    def design(self, text):
        (self.worktree / "docs").mkdir(exist_ok=True)
        design, plan = self.worktree / "docs" / "d.md", self.worktree / "docs" / "p.md"
        design.write_text(text)
        plan.write_text("# Plan\n")
        return design, plan

    GOOD_DESIGN = "# D\n\n## Contents\n\n- x\n\n```gherkin\nScenario: One\n  Given a\n```\n\n## Out of scope\n\nNothing.\n"

    def test_lint_research_needs_contents_gherkin_out_of_scope_and_plan(self):
        design, plan = self.design(self.GOOD_DESIGN)
        self.assertEqual(self.lint(spec_path=design, plan_path=str(plan), ticket_type="Research")[0], "complete")
        for broken in (self.GOOD_DESIGN.replace("## Contents", "## Index"),
                       self.GOOD_DESIGN.replace("Scenario: One", "Nothing here"),
                       self.GOOD_DESIGN.replace("## Out of scope", "## Extras")):
            with self.subTest(broken[:40]):
                design, plan = self.design(broken)
                self.assertEqual(self.lint(spec_path=design, plan_path=str(plan), ticket_type="Research")[0], "incomplete")
        design, _ = self.design(self.GOOD_DESIGN)
        self.assertEqual(self.lint(spec_path=design, plan_path=str(self.worktree / "none.md"), ticket_type="Research")[0],
                         "incomplete")
        outside = self.root / "design.md"
        outside.write_text(self.GOOD_DESIGN)
        self.assertEqual(self.lint(spec_path=outside, plan_path=str(plan), ticket_type="Research")[0], "incomplete")


class CheckReviewMovesToLibFeedback(Case):
    """The existing mode of check-review must write the same bytes after its writer moved to lib.feedback."""

    def test_check_review_file_is_byte_for_byte_the_same(self):
        from nondev_helpers import DESCRIPTION as NONDEV, KEY as NONDEV_KEY, write_artifacts
        _, evidence = write_artifacts(self.root)
        findings = [{"quote": "a one-page Markdown note with the two counts", "where": "Top", "problem": "No note",
                     "fix": "Add one"}]
        deps = make_deps(self.root, ticket=FakeTicket(description=NONDEV))
        REVIEW.run({"ticket_key": NONDEV_KEY, "findings": json.dumps(findings), "evidence_path": str(evidence)}, deps)
        written = (evidence.parent / (NONDEV_KEY + "-feedback.md")).read_text()
        self.assertEqual(written, (
            "# Feedback for JP-9001\n\nDefects the reviewer found, each quoting the ticket (contract feedback).\n\n---\n"
            '- quote: "a one-page Markdown note with the two counts"\n  where: "Top"\n  problem: "No note"\n'
            '  fix: "Add one"\n---\n'))

    def test_feedback_text_with_no_rows(self):
        self.assertEqual(feedback.feedback_text("Feedback for X", "Intro.", [], ("a",)),
                         "# Feedback for X\n\nIntro.\n\n---\n[]\n---\n")


if __name__ == "__main__":
    unittest.main()
