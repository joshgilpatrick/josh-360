"""JP-122: the triage graph's pure parts (checklist, route, sign-off filter, verdict, copy), on made-up tickets.

Run: python3 -m unittest discover -s graphs/tests   (from the repository root)
"""
from __future__ import annotations

import re
import unittest

import ticket_creation_helpers as h
import triage_helpers as t

from lib import adf, contracts
from lib.triage import checklist, copy, route, signoff, verdict
from lib.triage.registry import Registry
from lib.jira import Jira
from lib.triage.ticket import ticket_from_issue as _from_issue, ticket_version, parse_sections


def ticket_from_issue(raw, subtasks=None):
    """A Ticket from a raw Jira issue, through the shared client's own summary of it."""
    return _from_issue(Jira.__new__(Jira)._summarise(raw), subtasks)

REGISTRY = Registry.load()


def ctx(exists=True, after_edit=False):
    return checklist.Context(REGISTRY.lookup, REGISTRY.system_names, lambda key: exists, after_edit)


def ticket(type_="Story", sections=None, repository="josh-360", labels=None, where="Cloud session", **fields):
    desc = t.description(type=type_, sections=sections or {}, repository=repository, where_it_runs=where)
    return ticket_from_issue(t.issue(type_=type_, labels=labels, desc=desc, **fields))


def items(tk, **kw):
    return sorted({f["item"] for f in checklist.run_checklist(tk, ctx(**kw))})


class TheChecklistPasses(unittest.TestCase):
    def test_a_complete_story_has_no_failure(self):
        self.assertEqual(checklist.run_checklist(ticket(), ctx()), [])

    def test_a_task_may_have_repository_none(self):
        self.assertEqual(items(ticket("Task", repository="none", labels=[])), [])


class TheValidationItems(unittest.TestCase):
    """JP-165: V1 to V7 for the Validation section of a Story, Task or Bug (spec 2026-11-18-post-deploy-validation)."""

    def with_validation(self, text, type_="Story"):
        return ticket(type_, sections={"validation": text})

    def test_story_with_no_validation_section_fails_v1(self):
        tk = ticket()
        tk.sections = [s for s in tk.sections if s[0] != "Validation"]
        self.assertEqual(items(tk), ["V1"])
        found = checklist.run_checklist(tk, ctx())
        self.assertFalse([f for f in found if f["item"] == "C2" and f["where"] == "Validation"])

    def test_research_ticket_needs_no_validation_section(self):
        tk = ticket("Research", sections={"question": "Which table holds this?", "sources": ["ledger"],
                                          "deliverable_format": "a note"})
        self.assertFalse([i for i in items(tk) if i.startswith("V")])
        tk.sections = [s for s in tk.sections if s[0] != "Validation"]
        self.assertFalse([i for i in items(tk) if i.startswith("V")])

    def test_each_work_type_is_checked(self):
        for type_ in ("Story", "Task", "Bug"):
            tk = ticket(type_)
            tk.sections = [s for s in tk.sections if s[0] != "Validation"]
            self.assertIn("V1", items(tk), type_)

    def test_validation_reads_after_acceptance_criteria(self):
        tk = ticket()
        validation = [s for s in tk.sections if s[0] == "Validation"]
        tk.sections = [s for s in tk.sections if s[0] != "Validation"]
        index = [name for name, _ in tk.sections].index("Repository")
        tk.sections[index + 1:index + 1] = validation
        self.assertIn("C2", items(tk))

    def test_question_mark_in_a_validation_argument_is_not_c12(self):
        text = ("- Needed: yes\n- Starts: at Deployed\n- Check every: 1 day\n- Complete when: after 5 events\n"
                "- Give up after: 30 days\n\n```gherkin\n@validate\nScenario: Few open tickets\n"
                "  When the watch reads jira-count project = JP AND text ~ \"why?\"\n  Then count is at most 3\n```")
        self.assertEqual(items(self.with_validation(text)), [])

    def test_validation_scenarios_do_not_fail_c5_or_c6(self):
        self.assertEqual(items(self.with_validation(t.VALIDATION_YES)), [])

    def test_a_marker_in_a_validation_field_is_c12(self):
        self.assertIn("C12", items(self.with_validation("- Needed: no. Decide later: TBD for this ticket.")))

    def test_an_empty_validation_section_is_v1_only(self):
        self.assertEqual(items(self.with_validation("")), ["V1"])

    def test_a_placeholder_validation_section_is_v1_and_c12(self):
        self.assertEqual(items(self.with_validation("TBD")), ["C12", "V1"])

    def test_the_failure_names_the_line_and_the_form(self):
        found = checklist.run_checklist(self.with_validation(t.VALIDATION_YES.replace("Check every: 1 day",
                                                                                      "Check every: daily")), ctx())
        self.assertEqual([f["item"] for f in found], ["V3"])
        self.assertEqual(found[0]["where"], "Validation")
        self.assertIn("Check every: 'daily'", found[0]["found"])
        self.assertIn("<n> hours", found[0]["needed"])

    def test_sign_off_takes_a_j6_defect(self):
        defect = {"item": "J6", "quote": "Needed: no.", "problem": "the change runs in production",
                  "needed": "say Needed: yes and name what to watch"}
        kept, dropped = signoff.filter_defects([defect], "- Needed: no. The change is a document.")
        self.assertEqual((len(kept), len(dropped)), (1, 0))
        self.assertEqual(signoff.JUDGMENTS, ("J1", "J2", "J3", "J4", "J5", "J6"))


class OneCasePerItem(unittest.TestCase):
    def test_c1_a_type_that_never_enters_triage(self):
        self.assertEqual(items(ticket("Epic")), ["C1"])

    def test_c2_a_missing_section(self):
        tk = ticket()
        tk.sections = [s for s in tk.sections if s[0] != "Why"]
        self.assertIn("C2", items(tk))

    def test_c2_a_section_in_the_wrong_order_or_twice(self):
        tk = ticket()
        tk.sections = tk.sections + [("Goal", "again")]
        self.assertIn("C2", items(tk))

    def test_c3_an_empty_section(self):
        self.assertEqual(items(ticket(sections={"first_step": ""})), ["C3"])

    def test_c3_a_placeholder(self):
        self.assertEqual(items(ticket(sections={"goal": "TBD"})), ["C12", "C3"])

    def test_c4_no_gherkin_block_or_two(self):
        self.assertEqual(items(ticket(sections={"acceptance_criteria": "Feature: x"})), ["C4"])

    def test_c5_a_scenario_with_no_then(self):
        bad = h.GHERKIN.replace("\n    Then it lists each step and the copy is unchanged", "")
        self.assertEqual(items(ticket(sections={"acceptance_criteria": bad})), ["C5"])

    def test_c6_a_scenario_with_no_tag(self):
        self.assertEqual(items(ticket(sections={"acceptance_criteria": h.GHERKIN.replace("  @auto\n", "")})), ["C6"])

    def test_c6_two_tags(self):
        self.assertEqual(items(ticket(sections={"acceptance_criteria": h.GHERKIN.replace("@auto", "@auto @e2e")})), ["C6"])

    def test_c7_a_repository_the_registry_does_not_list(self):
        self.assertIn("C7", items(ticket(repository="no-such-repo")))

    def test_c8_the_system_label_is_missing(self):
        self.assertEqual(items(ticket(labels=[])), ["C8"])

    def test_c8_the_runners_start_label_is_not_a_gap(self):
        self.assertEqual(items(ticket(labels=["josh-360", "ready-to-run"])), [])     # JP-188
        self.assertEqual(items(ticket(labels=["josh-360", "equip"])), ["C8"])

    def test_c9_where_it_runs_says_neither(self):
        self.assertEqual(items(ticket(where="On a server")), ["C9"])

    def test_c9_a_laptop_ticket_must_say_why(self):
        self.assertEqual(items(ticket(where="Josh's laptop")), ["C9"])
        self.assertEqual(items(ticket(where="Josh's laptop because it reads the laptop ledger")), [])

    def test_c10_a_key_that_does_not_exist_and_a_parent_in_another_space(self):
        self.assertEqual(items(ticket(sections={"parent_or_related": "Parent: JP-94"}), exists=False), ["C10"])
        self.assertEqual(items(ticket(sections={"parent_or_related": "Parent: AD-5"})), ["C10"])

    def test_c10_an_unreadable_key_is_unknown_not_missing(self):
        unknown = checklist.Context(REGISTRY.lookup, REGISTRY.system_names, lambda key: None)
        with self.assertRaises(checklist.Unknown):
            checklist.run_checklist(ticket(), unknown)

    def test_c11_a_subtask_with_no_done_when(self):
        sub = ticket_from_issue(t.issue("JP-9002", type_="Subtask", desc=adf.doc(adf.labelled("Goal", "Do it"))))
        tk = ticket()
        tk.subtasks = [sub]
        self.assertIn("C11", items(tk))

    def test_c12_an_open_question_a_marker_a_flag_and_an_unanswered_send_back(self):
        self.assertIn("C12", items(ticket(sections={"why": "Josh wants a preview.\nWhich table holds this?"})))
        self.assertIn("C12", items(ticket(sections={"why": "Decide later: TBD"})))
        self.assertIn("C12", items(ticket(), after_edit=True))
        flagged = ticket()
        flagged.flagged = True
        self.assertIn("C12", items(flagged))

    def test_c12_a_quoted_question_mark_is_not_a_question(self):
        self.assertEqual(items(ticket(sections={"why": 'The prompt reads "Which table?" in the log.'})), [])

    def test_c13_patient_data_names_the_section_and_never_the_text(self):
        found = checklist.run_checklist(ticket(sections={"why": "member 000-00-0000 called"}), ctx())
        self.assertEqual([f["item"] for f in found], ["C13"])
        self.assertNotIn("000-00-0000", str(found))

    def test_b1_a_bug_needs_its_current_behaviour_lines(self):
        bug = ticket("Bug", sections={"current_behaviour": "Steps to reproduce: run it"})
        self.assertEqual(sorted({f["item"] for f in checklist.run_checklist(bug, ctx())}), ["B1"])

    def test_b2_and_s1_a_bug_or_story_needs_a_repository(self):
        self.assertIn("S1", items(ticket("Story", repository="none")))
        self.assertIn("B2", items(ticket("Bug", repository="none", sections={
            "current_behaviour": "Steps to reproduce: a\nExpected: b\nActual: c\nEnvironment: d\nAffected system: e"})))

    def test_r1_a_research_ticket_needs_question_sources_and_deliverable(self):
        tk = ticket("Research", sections={"question": "", "sources": [], "deliverable_format": ""})
        self.assertEqual(items(tk), ["R1"])

    def test_a_research_ticket_keeps_its_open_questions(self):
        tk = ticket("Research", sections={"question": "Which table holds this?", "sources": ["ledger"],
                                          "deliverable_format": "a note", "open_questions": ["Is it one table?"]})
        self.assertEqual(items(tk), [])


class RoutingIsOneRowPerCase(unittest.TestCase):
    def test_the_table(self):
        self.assertEqual(route.decide_route("Story", "josh-360", None), ("development", ""))
        self.assertEqual(route.decide_route("Task", "none", None), ("non_development", ""))
        self.assertEqual(route.decide_route("Research", "josh-360", None)[0], "development")
        self.assertEqual(route.decide_route("Research", "none", None)[0], "non_development")

    def test_conflicts(self):
        self.assertEqual(route.decide_route("Story", "none", None)[0], "conflict")
        self.assertEqual(route.decide_route("Bug", "none", None)[0], "conflict")
        self.assertEqual(route.decide_route("Task", "none", "code")[0], "conflict")

    def test_the_route_never_mentions_priority(self):
        for args in (("Story", "josh-360", None), ("Task", "none", "code")):
            self.assertNotIn("priority", str(route.decide_route(*args)).lower())


class TheSignOffFilter(unittest.TestCase):
    TEXT = "Goal: laptop/install.py --dry-run prints every step.\nFirst step: Read STEPS in laptop/install.py."

    def defect(self, **over):
        base = {"item": "J1", "quote": "Read STEPS in laptop/install.py.", "problem": "no file named", "needed": "name it"}
        base.update(over)
        return base

    def test_a_defect_that_quotes_the_ticket_is_kept(self):
        kept, dropped = signoff.filter_defects([self.defect()], self.TEXT)
        self.assertEqual((len(kept), len(dropped)), (1, 0))

    def test_quotes_survive_case_whitespace_and_typographic_quotes(self):
        kept, _ = signoff.filter_defects([self.defect(quote="“read  steps in laptop/install.py.”")], self.TEXT)
        self.assertEqual(len(kept), 1)

    def test_a_defect_is_dropped_with_its_reason(self):
        cases = [(self.defect(quote="not in the ticket"), "quote not in ticket"),
                 (self.defect(item="J9"), "item is not J1 to J6"),
                 (self.defect(needed=" "), "quote, problem or needed is empty"), ("nonsense", "not a defect entry")]
        for defect, reason in cases:
            kept, dropped = signoff.filter_defects([defect], self.TEXT)
            self.assertEqual((kept, dropped[0]["reason"]), ([], reason), defect)

    def test_the_signer_is_never_an_author(self):
        self.assertTrue(signoff.signer_is_author("s1", ["s0", "s1"]))
        self.assertFalse(signoff.signer_is_author("s2", ["s0", "s1"]))
        self.assertFalse(signoff.signer_is_author("", [""]))


class TheVerdict(unittest.TestCase):
    GAP = [{"item": "C3", "where": "Goal", "found": "empty", "needed": "Fill it in."}]

    def test_ready_needs_a_route_and_a_signed_off_ticket(self):
        self.assertEqual(verdict.decide("own", [], "", "development", [], 0), ("ready", []))
        with self.assertRaises(ValueError):
            verdict.decide("own", [], "", "development", None, 0)          # sign-off never ran
        with self.assertRaises(ValueError):
            verdict.decide("own", [], "", None, [], 0)                      # no route

    def test_gaps_are_numbered_failures_then_conflict_then_defects(self):
        defect = {"item": "J1", "quote": "x", "problem": "p", "needed": "n"}
        _, gaps = verdict.decide("own", self.GAP, "A Story with Repository none has no route.", None, [defect], 0)
        self.assertEqual([(g["n"], g["item"]) for g in gaps], [(1, "C3"), (2, "ROUTE"), (3, "J1")])

    def test_own_revises_other_comments(self):
        self.assertEqual(verdict.decide("own", self.GAP, "", None, None, 0)[0], "revise")
        self.assertEqual(verdict.decide("other", self.GAP, "", None, None, 0)[0], "comment")

    def test_a_third_return_of_an_own_ticket_escalates_but_someone_elses_never_does(self):
        self.assertEqual(verdict.decide("own", self.GAP, "", None, None, 2)[0], "revise")
        self.assertEqual(verdict.decide("own", self.GAP, "", None, None, 3)[0], "escalate")
        self.assertEqual(verdict.decide("other", self.GAP, "", None, None, 9)[0], "comment")

    def test_two_drafter_rounds_then_exhausted_and_one_more_each_time_josh_chooses_it(self):
        self.assertEqual(verdict.decide("own", self.GAP, "", None, None, 0, rounds=1)[0], "revise")
        self.assertEqual(verdict.decide("own", self.GAP, "", None, None, 0, rounds=2)[0], "exhausted")
        self.assertEqual(verdict.decide("own", self.GAP, "", None, None, 0, rounds=2, round_budget=3)[0], "revise")
        self.assertEqual(verdict.decide("other", self.GAP, "", None, None, 0, rounds=5)[0], "comment")

    def test_the_return_count(self):
        self.assertEqual(verdict.count_returns(None, 2, False), 2)
        self.assertEqual(verdict.count_returns({"returns": 2, "returns_seen": 2}, 3, False), 3)
        self.assertEqual(verdict.count_returns({"returns": 2, "returns_seen": 2}, 3, True), 0)
        self.assertEqual(verdict.count_returns({"returns": True}, 0, False), 0)


class TheCopyMatchesTheSpec(unittest.TestCase):
    """Each comment is held to the spec's own text, so the two cannot drift."""
    SPEC = (h.ROOT / "docs/superpowers/specs/2026-11-16-triage-graph-design.md").read_text(encoding="utf-8")

    def block(self, heading):
        start = self.SPEC.index(heading)
        body = self.SPEC[start:].split("```text\n", 1)[1].split("```", 1)[0]
        return body

    def shape(self, text):
        return re.sub(r"<[^>]*>", "<>", text).strip()

    def test_the_send_back(self):
        want = self.block("**Comment to someone else's author (`send-back`):**").replace("<run id>", "r-1").splitlines()
        got = copy.send_back("r-1", [{"n": 1, "item": "C6", "where": "Acceptance criteria",
                                      "found": 'Scenario "x" has no test tag.',
                                      "needed": "one of @auto, @e2e or @manual."}]).splitlines()
        self.assertEqual(got[0], want[0])
        self.assertEqual(got[1], want[1])
        self.assertEqual(got[2], want[2].replace("<name>", "x"))
        self.assertEqual(got[-1], want[-1])

    def test_the_round_note(self):
        want = self.block("**Comment after a drafter round (`apply-revision`):**").splitlines()
        got = copy.round_note(1, "r-1", [1, 2], ["Goal", "Why"]).splitlines()
        self.assertEqual(got[0].replace("round 1", "round <n>").replace("r-1", "<run id>"), want[0])
        self.assertEqual(got[1], "Closed: 1, 2. Changed sections: Goal, Why.")

    def test_the_question(self):
        want = self.block("**Ask, `ask_josh`:**").splitlines()
        got = copy.question("r-1", "Which table holds this", "the ledger table", "it is the only one").splitlines()
        self.assertEqual(got[0].replace("r-1", "<run id>"), want[0])
        self.assertTrue(got[1].endswith("?"))
        self.assertEqual(got[2], "Recommended: the ledger table, because it is the only one.")

    def test_ready(self):
        want = self.block("**Comment on Ready (`mark-ready`):**").strip()
        got = copy.ready("r-1", "s-1", "development", "josh-360", False)
        pattern = re.escape(want).replace(re.escape("<run id>"), "r-1").replace(re.escape("<id>"), "s-1")
        pattern = pattern.replace(re.escape("<development or non-development>"), "development").replace(
            re.escape("<system>"), "josh-360")
        pattern = pattern.replace(re.escape("<starts when Josh queues it | starts now>"), "starts when Josh queues it")
        self.assertEqual(got, re.sub(r"\\", "", pattern))
        self.assertTrue(copy.ready("r-1", "s-1", "development", "josh-360", True).endswith("starts now"))

    def test_a_triage_comment_is_recognised_by_its_prefix_only(self):
        self.assertTrue(copy.is_triage_comment("Triage: Ready | run r"))
        self.assertFalse(copy.is_triage_comment("Returned to triage | run r"))
        self.assertTrue(copy.is_return_note("Returned to triage | from run r"))


class TheRunLabel(unittest.TestCase):
    def test_a_ticket_with_the_label_starts_now_and_one_without_waits(self):
        from lib.triage import RUN_LABEL, port
        self.assertTrue(port.has_run_label({"fields": {"labels": ["x", RUN_LABEL]}}))
        self.assertFalse(port.has_run_label({"fields": {"labels": ["x"]}}))
        self.assertFalse(port.has_run_label({"fields": {}}))


class TheNewSharedPieces(unittest.TestCase):
    def test_the_version_changes_with_the_description_the_summary_the_type_labels_and_links(self):
        base = ticket_version(ticket())
        self.assertEqual(base, ticket_version(ticket()))
        self.assertNotEqual(base, ticket_version(ticket(sections={"goal": "A different goal."})))
        self.assertNotEqual(base, ticket_version(ticket(summary="A different summary")))
        self.assertNotEqual(base, ticket_version(ticket(labels=["josh-360", "improvement"])))

    def test_a_script_written_description_reads_back_the_same(self):
        tk = ticket()
        self.assertEqual([n for n, _ in tk.sections][:3], ["Goal", "First step", "Why"])
        self.assertEqual(parse_sections(adf.to_marked(t.description()).strip("\n")), tk.sections)

    def test_a_heading_or_plain_label_opens_no_section(self):
        self.assertEqual(parse_sections("## Goal\nsomething\nGoal: plain"), [])

    def test_a_gherkin_fence_survives_marking(self):
        self.assertIn("```gherkin", adf.to_marked(t.description()))

    def test_a_revision_must_be_one_ticket_with_a_key(self):
        proposal = {"action": "revise", "closes": [1], "authors": ["s-1"], "tickets": [
            {"key": "JP-9001", "type": "Story", "repository": "josh-360", "where_it_runs": "Cloud session",
             "sections": h.section_set()}]}
        self.assertEqual(contracts.revision_problems(proposal), [])
        for bad in ({"closes": ["1"]}, {"authors": []}, {"tickets": []}, {"action": "create"}):
            self.assertTrue(contracts.revision_problems(dict(proposal, **bad)), bad)

    def test_a_question_needs_a_sentence_a_recommendation_and_a_reason(self):
        good = {"action": "revise", "needs_josh": {"question": "Which file?", "recommendation": "a", "reason": "b"}}
        self.assertEqual(contracts.question_problems(good), [])
        self.assertTrue(contracts.question_problems({"action": "revise", "needs_josh": {"question": "Which file"}}))


if __name__ == "__main__":
    unittest.main()
