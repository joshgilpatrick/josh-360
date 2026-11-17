"""read-dev-ticket, prepare-worktree, return-to-triage (with a card) and check-review (hardening mode) (JP-115, Task 8)."""
from __future__ import annotations

import json
import os
import unittest
from pathlib import Path

from dev_helpers import DESCRIPTION, KEY, Case, FakeTicket, gate, make_dev_deps, scratch_repo, spec_copy, write_spec
from lib import dev_git
from lib.gate_run import GateError

DEV = {"graph": "development"}


def inputs(**over):
    base = {"ticket_key": KEY, "ticket_type": "Story", "system": "widgets", "resume_from": None}
    base.update(over)
    return base


class ReadDevTicket(Case):
    def setUp(self):
        super().setUp()
        self.origin, self.clone = scratch_repo(self.root)
        dev_git.git(self.clone, "remote", "set-url", "origin", "https://github.com/josh/widgets.git")
        self.gate = gate("read-dev-ticket")

    def ticket(self, **over):
        args = dict(description=DESCRIPTION, status="Ready", route=DEV, key=KEY, issuetype="Story",
                    summary="Label the widget", agent_status=None)
        args.update(over)
        return FakeTicket(**args)

    def go(self, ticket=None, merges="josh", **over):
        deps = make_dev_deps(self.root, ticket=ticket or self.ticket(), clone=self.clone, merges=merges)
        return self.gate.run(inputs(**over), deps), deps

    def refused(self, reason, ticket=None, **over):
        (outcome, outputs, _), _ = self.go(ticket, **over)
        self.assertEqual(outcome, "not_here")
        self.assertEqual(outputs, {"reason": reason})

    def test_not_a_jp_key(self):
        self.refused("the development graph works JP tickets only", ticket_key="AD-5")

    def test_unreadable_ticket(self):
        self.refused("the ticket could not be read", ticket=self.ticket(key="JP-1"))   # JP-9002 is not in the fake

    def test_not_ready(self):
        self.refused("the ticket is not Ready", ticket=self.ticket(status="Design/Planning"))

    def test_not_routed_development(self):
        self.refused("the ticket is not routed to the development graph", ticket=self.ticket(route={"graph": "non-development"}))

    def test_no_route_record(self):
        t = self.ticket()
        t.tickets[KEY] = t.tickets[KEY]._replace(route=None)
        self.refused("the ticket is not routed to the development graph", ticket=t)

    def test_type_not_built_here(self):
        self.refused("the ticket type is not one the development graph builds", ticket=self.ticket(issuetype="Epic"),
                     ticket_type="Epic")

    def test_type_differs_from_the_input(self):
        self.refused("the ticket type is not one the development graph builds", ticket_type="Bug")

    def test_system_differs(self):
        self.refused("the ticket's system has no repository in the registry",
                     ticket=self.ticket(route={"graph": "development", "system": "gadgets"}))

    def test_registry_has_no_repository_for_the_system(self):
        self.refused("the ticket's system has no repository in the registry", system="gadgets")

    def test_flag_is_on(self):
        self.refused("the ticket has an open question", ticket=self.ticket(flagged=True))

    def test_open_question_bullet(self):
        text = DESCRIPTION.replace("- Answered: which colour? Blue.", "- Answered: which colour? Blue.\n- Should it blink?")
        self.refused("the ticket has an open question", ticket=self.ticket(description=text))

    def test_no_open_questions_section_is_fine(self):
        text = DESCRIPTION.split("**Open questions:**")[0]
        (outcome, _, _), _ = self.go(ticket=self.ticket(description=text))
        self.assertEqual(outcome, "build")

    def test_another_runner_holds_it(self):
        self.refused("another runner holds the ticket", ticket=self.ticket(agent_status="Running"))

    def test_finished_status_does_not_hold_it(self):
        (outcome, _, _), _ = self.go(ticket=self.ticket(agent_status="Finished"))
        self.assertEqual(outcome, "build")

    def test_reason_carries_nothing_from_the_ticket(self):
        t = self.ticket(description="Patient: Smith\n" + DESCRIPTION, status="Backlog")
        (_, outputs, summary), _ = self.go(ticket=t)
        self.assertNotIn("Smith", json.dumps(outputs) + summary)

    def test_build_for_story(self):
        (outcome, outputs, _), _ = self.go()
        self.assertEqual(outcome, "build")
        self.assertEqual(outputs["repo"], "josh/widgets")
        self.assertEqual(outputs["prior_spec"], "none")

    def test_design_only_for_research(self):
        (outcome, outputs, _), _ = self.go(ticket=self.ticket(issuetype="Research"), ticket_type="Research")
        self.assertEqual(outcome, "design_only")
        self.assertEqual(outputs["repo"], "josh/widgets")

    def test_prior_spec_found_in_the_returned_runs_work_folder(self):
        work = self.root / "runs" / "old-run" / "work"
        work.mkdir(parents=True)
        (work / "spec.yaml").write_text("{}")
        (_, outputs, _), _ = self.go(resume_from="old-run")
        self.assertEqual(outputs["prior_spec"], str(work / "spec.yaml"))

    def test_prior_spec_falls_back_to_the_newest_saved_copy(self):
        saved = self.root / "runs" / "old-run" / "saved"
        saved.mkdir(parents=True)
        older, newer = saved / "01-design-spec_path.yaml", saved / "04-design-spec_path.yaml"
        older.write_text("{}")
        newer.write_text("{}")
        os.utime(str(older), (1, 1))
        (_, outputs, _), _ = self.go(resume_from="old-run")
        self.assertEqual(outputs["prior_spec"], str(newer))

    def test_prior_spec_none(self):
        (_, outputs, _), _ = self.go(resume_from="no-such-run")
        self.assertEqual(outputs["prior_spec"], "none")

    def test_resume_from_cannot_climb_out_of_the_runs_folder(self):
        (_, outputs, _), _ = self.go(resume_from="../../etc")
        self.assertEqual(outputs["prior_spec"], "none")

    def test_no_clone_is_a_gate_error(self):
        deps = make_dev_deps(self.root, ticket=self.ticket(), clone=self.root / "missing")
        with self.assertRaises(GateError):
            self.gate.run(inputs(), deps)


class PrepareWorktree(Case):
    def setUp(self):
        super().setUp()
        self.origin, self.clone = scratch_repo(self.root)
        self.gate = gate("prepare-worktree")

    def go(self, summary="Label the widget"):
        deps = make_dev_deps(self.root, ticket=FakeTicket(key=KEY, summary=summary, route=DEV), clone=self.clone)
        return self.gate.run({"ticket_key": KEY, "repo": "josh/widgets", "base_branch": "main"}, deps), deps

    def test_prepare_cuts_branch_from_origin_base(self):
        (outcome, out, _), deps = self.go()
        self.assertEqual(outcome, "ready")
        self.assertEqual(out["branch"], "JP-9002-label-the-widget")
        self.assertEqual(Path(out["worktree"]), self.clone / ".claude" / "worktrees" / "JP-9002-label-the-widget")
        self.assertEqual(dev_git.git(Path(out["worktree"]), "branch", "--show-current"), out["branch"])
        self.assertEqual(Path(out["work_dir"]), deps.work_dir)
        self.assertEqual(dev_git.git(self.clone, "branch", "--show-current"), "main")

    def test_prepare_reuses_the_one_ticket_branch(self):
        (_, first, _), _ = self.go()
        (_, second, _), _ = self.go(summary="A different summary now")
        self.assertEqual(first["branch"], second["branch"])
        self.assertEqual(first["worktree"], second["worktree"])

    def test_prepare_reuses_a_branch_that_exists_only_on_origin(self):
        dev_git.git(self.clone, "push", "origin", "main:JP-9002-earlier-name")
        (_, out, _), _ = self.go()
        self.assertEqual(out["branch"], "JP-9002-earlier-name")

    def test_prepare_refuses_two_ticket_branches(self):
        dev_git.git(self.clone, "branch", "JP-9002-one")
        dev_git.git(self.clone, "branch", "JP-9002-two")
        with self.assertRaises(GateError) as caught:
            self.go()
        self.assertIn("JP-9002-one", str(caught.exception))
        self.assertIn("JP-9002-two", str(caught.exception))

    def test_prepare_work_dir_is_outside_the_clone(self):
        (_, out, _), _ = self.go()
        work = Path(out["work_dir"]).resolve()
        self.assertTrue(work.is_dir())
        self.assertNotIn(self.clone.resolve(), work.parents)

    def test_a_flagged_summary_gives_the_slug_work(self):
        (_, out, _), _ = self.go(summary="Fix the label for Patient: Smith")
        self.assertEqual(out["branch"], "JP-9002-work")

    def test_the_clone_is_left_alone(self):
        (self.clone / "scrap.txt").write_text("mine")
        before = dev_git.git(self.clone, "status", "--porcelain")
        self.go()
        self.assertEqual(dev_git.git(self.clone, "status", "--porcelain"), before)
        self.assertEqual((self.clone / "scrap.txt").read_text(), "mine")

    def test_unknown_repo_is_a_gate_error(self):
        deps = make_dev_deps(self.root, ticket=FakeTicket(key=KEY, summary="x"), clone=self.clone)
        with self.assertRaises(GateError):
            self.gate.run({"ticket_key": KEY, "repo": "josh/gadgets", "base_branch": "main"}, deps)


class ReturnToTriage(Case):
    def setUp(self):
        super().setUp()
        self.origin, self.clone = scratch_repo(self.root)
        self.gate = gate("return-to-triage")
        self.tree = dev_git.add_worktree(self.clone, "JP-9002-label", "main")

    def deps(self):
        return make_dev_deps(self.root, ticket=FakeTicket(key=KEY, route=DEV), clone=self.clone)

    def card(self, **over):
        args = {"ticket_key": KEY, "reason": None, "card": "Which of the two screens should the label appear on?",
                "worktree": str(self.tree), "work_dir": None, "phi": "false"}
        args.update(over)
        return args

    def test_return_without_card_is_unchanged(self):
        deps = self.deps()
        outcome, outputs, summary = self.gate.run({"ticket_key": KEY, "reason": "the ticket is not Ready"}, deps)
        self.assertEqual((outcome, outputs, summary), ("returned", None, "returned to triage"))
        self.assertEqual(deps.ticket.moves, [(KEY, "Not Started")])
        self.assertEqual(deps.ticket.flags, [(KEY, True)])
        self.assertTrue(self.tree.exists())   # no card: no worktree is touched

    def test_return_with_card_comments_the_spec_copy(self):
        deps = self.deps()
        self.gate.run(self.card(work_dir=str(deps.work_dir)), deps)
        key, text = deps.ticket.posted[-1]
        self.assertTrue(text.startswith("Returned to triage | the designer needs: Which of the two screens"), text)
        self.assertIn("run run-1, spec saved | next gate: triage answers it, then this run resumes", text)
        self.assertEqual((deps.work_dir / "question.md").read_text(), "Which of the two screens should the label appear on?")
        self.assertEqual(deps.ticket.moves, [(KEY, "Not Started")])
        self.assertEqual(deps.ticket.flags, [(KEY, True)])

    def test_return_withholds_the_question_when_phi(self):
        for value in ("true", None):
            deps = self.deps()
            self.gate.run(self.card(work_dir=str(deps.work_dir), phi=value), deps)
            text = deps.ticket.posted[-1][1]
            self.assertIn("withheld: patient data, see {}".format(deps.work_dir / "question.md"), text)
            self.assertNotIn("Which of the two screens", text)

    def test_return_withholds_a_question_the_screen_flags(self):
        deps = self.deps()
        self.gate.run(self.card(work_dir=str(deps.work_dir), card="Is the Patient: Smith label right?"), deps)
        self.assertIn("withheld", deps.ticket.posted[-1][1])
        self.assertNotIn("Smith", deps.ticket.posted[-1][1])

    def test_return_removes_an_untouched_worktree(self):
        deps = self.deps()
        _, _, summary = self.gate.run(self.card(work_dir=str(deps.work_dir)), deps)
        self.assertFalse(self.tree.exists())
        self.assertIn("worktree removed", summary)

    def test_return_keeps_a_worktree_with_commits(self):
        (self.tree / "a.txt").write_text("a")
        dev_git.git(self.tree, "add", "a.txt")
        dev_git.git(self.tree, "-c", "user.name=T", "-c", "user.email=t@e.com", "commit", "-m", "work")
        deps = self.deps()
        _, _, summary = self.gate.run(self.card(work_dir=str(deps.work_dir)), deps)
        self.assertTrue(self.tree.exists())
        self.assertIn("worktree kept", summary)

    def test_return_keeps_a_worktree_with_uncommitted_files(self):
        (self.tree / "scrap.txt").write_text("x")
        deps = self.deps()
        _, _, summary = self.gate.run(self.card(work_dir=str(deps.work_dir)), deps)
        self.assertTrue((self.tree / "scrap.txt").exists())
        self.assertIn("worktree kept", summary)

    def test_return_still_returns_when_the_worktree_is_already_gone(self):
        dev_git.remove_worktree(self.clone, self.tree, "JP-9002-label")
        deps = self.deps()
        outcome, _, _ = self.gate.run(self.card(work_dir=str(deps.work_dir)), deps)
        self.assertEqual(outcome, "returned")

    def test_the_question_file_goes_only_to_this_runs_work_folder(self):
        deps = self.deps()
        with self.assertRaises(GateError):
            self.gate.run(self.card(work_dir=str(self.tree)), deps)   # inside the worktree: refused
        self.assertEqual(deps.ticket.moves, [])


class CheckReviewHardening(Case):
    def setUp(self):
        super().setUp()
        self.gate = gate("check-review")
        self.deps_ = make_dev_deps(self.root, ticket=FakeTicket(key=KEY, route=DEV))
        self.work = self.deps_.work_dir
        self.spec_path = write_spec(self.work, spec_copy())

    def go(self, findings, **over):
        args = {"ticket_key": KEY, "findings": json.dumps(findings), "evidence_path": None,
                "spec_path": str(self.spec_path), "plan_path": None, "work_dir": str(self.work)}
        args.update(over)
        return self.gate.run(args, self.deps_)

    def finding(self, quote):
        return {"quote": quote, "where": "p1", "problem": "unclear", "fix": "say it"}

    def test_harden_finding_quoting_the_spec_is_kept(self):
        outcome, _, summary = self.go([self.finding("Put the word widget in it")])
        self.assertEqual(outcome, "rework")
        text = (self.work / "hardening.md").read_text()
        self.assertIn("Put the word widget in it", text)
        self.assertEqual(summary, "1 of 1 findings kept")

    def test_harden_finding_quoting_the_ticket_is_kept(self):
        t = FakeTicket(key=KEY, route=DEV, description=DESCRIPTION)
        self.deps_.ticket = t
        outcome, _, _ = self.go([self.finding("which colour? Blue.")])
        self.assertEqual(outcome, "rework")

    def test_harden_finding_quoting_nothing_is_dropped_and_logged(self):
        outcome, _, summary = self.go([self.finding("a line that is nowhere")])
        self.assertEqual(outcome, "clean")
        self.assertEqual(summary, "0 of 1 findings kept")
        self.assertIn("quotes nothing in the spec or the ticket", (self.work / "withdrawn.md").read_text())
        self.assertFalse((self.work / "hardening.md").exists())

    def test_harden_quote_across_json_escapes(self):
        spec = spec_copy(summary='Adds a "label" to the widget.')
        write_spec(self.work, spec)
        raw = (self.work / "spec.yaml").read_text()
        self.assertIn('\\"label\\"', raw)   # the file holds the escaped form; the decoded text is what matches
        outcome, _, _ = self.go([self.finding('Adds a "label" to the widget.')])
        self.assertEqual(outcome, "rework")

    def test_harden_clean_empties_an_old_file(self):
        self.go([self.finding("Put the word widget in it")])
        self.assertIn("Put the word", (self.work / "hardening.md").read_text())
        outcome, _, _ = self.go([])
        self.assertEqual(outcome, "clean")
        self.assertIn("[]", (self.work / "hardening.md").read_text())
        self.assertNotIn("Put the word", (self.work / "hardening.md").read_text())

    def test_research_hardening_reads_the_design_and_the_plan(self):
        design = self.work / "design.md"
        plan = self.work / "plan.md"
        design.write_text("The design says to use a blue badge.\n")
        plan.write_text("Step one: add the badge.\n")
        args = dict(spec_path=str(design), plan_path=str(plan))
        self.assertEqual(self.go([self.finding("use a blue badge")], **args)[0], "rework")
        self.assertEqual(self.go([self.finding("Step one: add the badge.")], **args)[0], "rework")
        self.assertEqual(self.go([self.finding("Put the word widget in it")], **args)[0], "clean")

    def test_harden_refuses_a_work_dir_that_is_not_this_runs(self):
        with self.assertRaises(GateError):
            self.go([], work_dir=str(self.root / "elsewhere"))

    def test_harden_unreadable_spec_is_a_gate_error(self):
        with self.assertRaises(GateError):
            self.go([], spec_path=str(self.work / "absent.yaml"))

    def test_harden_findings_not_a_list_is_a_gate_error(self):
        with self.assertRaises(GateError):
            self.gate.run({"ticket_key": KEY, "findings": "{", "spec_path": str(self.spec_path), "work_dir": str(self.work),
                           "evidence_path": None, "plan_path": None}, self.deps_)


if __name__ == "__main__":
    unittest.main()
