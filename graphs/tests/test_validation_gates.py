"""JP-167, Task 8: the validation graph's exact copy, entry gate, reader and verdict. Made-up tickets only.

Run: python3 -m unittest discover -s graphs/tests -p "test_validation_gates.py"   (from the repository root)
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import validation_gate_helpers as h
from validation_gate_helpers import KEY, Site, load_gate

from lib import validation_copy as copy, validation_section
from lib.gate_run import GateError
from lib.watch import log, round as watch_round

deployed = load_gate("deployed")
read_validation = load_gate("read-validation")
verdict_gate = load_gate("validation-verdict")

CRITERIA = [
    {"id": "V1", "name": "The retirement job runs clean", "collector": "job", "argument": "retire-job",
     "checks": [{"field": "last_exit", "comparison": "is", "value": 0}], "manual": False, "statement": ""},
    {"id": "V2", "name": "The doctor reports no failed check", "collector": "report", "argument": "doctor summary.fail",
     "checks": [{"field": "value", "comparison": "is", "value": 0}], "manual": False, "statement": ""},
]
MANUAL = {"id": "V3", "name": "The summaries read well", "collector": "", "argument": "", "checks": [], "manual": True,
          "statement": "the summaries read as plain English"}


def entry(cid, checks, passed, failed, unknown=0, streak=0, last=None, link=""):
    return {"id": cid, "checks": checks, "passed": passed, "failed": failed, "unknown": unknown, "streak": streak,
            "last": last or {}, "link": link}


GOOD = [entry("V1", 3, 3, 0, streak=3, last={"last_exit": 0}), entry("V2", 3, 3, 0, streak=3, last={"value": 0})]
BAD = [entry("V1", 3, 0, 3, last={"last_exit": 1}), entry("V2", 3, 3, 0, streak=3, last={"value": 0})]


def j(value):
    return json.dumps(value)


class Base(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.site = Site(tmp.name)
        self.deps = self.site.deps

    def end_line(self, result, reason, tally=None, round_no=1, **plan):
        folder = self.deps.work_dir / "watch"
        path = folder / "round-{}.json".format(round_no)
        watch_round.write_plan(path, dict({"ticket_key": KEY, "round": round_no}, **plan))
        log.append(log.path_for(path), {"kind": "end", "at": "2026-11-18T13:00:00Z", "result": result,
                                        "reason": reason, "tally": tally or []})


class TheCopy(unittest.TestCase):
    def test_copy_is_the_specs(self):
        self.assertEqual(
            copy.start(2, 24, "7 checks in a row pass", 21, "2026-11-19 14:05"),
            "Watching this change in production | 2 criteria; a check every 1 day; complete when 7 checks in a row "
            "pass; gives up after 21 days | next gate: first check due 2026-11-19 14:05.")
        self.assertEqual(
            copy.start(1, 6, "after 20 events", 1, "one check after JP-170 is Done"),
            "Watching this change in production | 1 criterion; a check every 6 hours; complete when after 20 events; "
            "gives up after 1 day | next gate: first check due one check after JP-170 is Done.")
        self.assertEqual(
            copy.met("7 checks in a row pass", 9, 1),
            "Validated in production | 7 checks in a row pass, reached on check 9 of round 1 | next gate: none.")
        self.assertEqual(copy.unwatched("the ticket has no Validation section"),
                         "Nothing to watch | the ticket has no Validation section | next gate: none.")
        self.assertEqual(
            copy.not_met("The job: 3 of 3 checks failed", "JP-9002"),
            "Not met in production | The job: 3 of 3 checks failed | next gate: JP-9002; the watch starts again "
            "when it ships.")
        self.assertEqual(
            copy.accepted("2026-11-19", "No readings came back."),
            "Closed on Josh's answer (2026-11-19) | the watch had not shown the criteria met: No readings came back. "
            "| next gate: none.")
        self.assertEqual(
            copy.hold(),
            "Watch stopped at Josh's request | this ticket stays in Deployed and is flagged, so nothing is watching "
            "it | next gate: clear the flag to start a fresh watch, or move the ticket.")

    def test_reasons_and_intervals(self):
        self.assertEqual([copy.interval(h) for h in (1, 6, 24, 72, 36)],
                         ["1 hour", "6 hours", "1 day", "3 days", "36 hours"])
        self.assertEqual(copy.no_section(), "the ticket has no Validation section")
        self.assertEqual(copy.says_no("The change is a document."),
                         'the ticket says "Needed: no": The change is a document.')

    def test_evidence_table_holds_counts_and_links_only(self):
        tally = [entry("V1", 9, 7, 1, unknown=1, streak=7, last={"last_exit": 0, "hours_since_run": 0.4},
                       link="reports/x"), entry("V2", 0, 0, 0)]
        table = copy.evidence_table(CRITERIA + [MANUAL], tally + [entry("V3", 0, 0, 0)])
        rows = table.split("\n")
        self.assertEqual(rows[0], "| Criterion | Checks | Passed | Failed | Unknown | Last reading | Link |")
        self.assertEqual(len(rows), 2 + 3)
        self.assertEqual(rows[2], "| The retirement job runs clean | 9 | 7 | 1 | 1 | last_exit 0, hours_since_run 0.4 "
                                  "| reports/x |")
        self.assertIn("for Josh to confirm", rows[4])
        self.assertNotIn("\n\n", table)

    def test_a_pipe_in_a_criterion_name_cannot_split_a_row(self):
        named = [dict(CRITERIA[0], name="runs | clean")]
        row = copy.evidence_table(named, [entry("V1", 1, 1, 0, streak=1)]).split("\n")[2]
        self.assertEqual(row.count("|"), 8)

    def test_failed_text(self):
        self.assertEqual(copy.failed_text(CRITERIA, [entry("V1", 3, 0, 3), entry("V2", 4, 3, 1)]),
                         "The retirement job runs clean: 3 of 3 checks failed; "
                         "The doctor reports no failed check: 1 of 4 checks failed")

    def test_bug_ticket_follows_the_template(self):
        bug = copy.bug_ticket("JP-9001", "josh-360", CRITERIA, [entry("V1", 3, 0, 3)])
        self.assertEqual(bug["summary"], "JP-9001 did not meet its validation: The retirement job runs clean")
        self.assertEqual(bug["type"], "Bug")
        self.assertEqual(bug["labels"], ["validation-failure", "josh-360"])
        self.assertEqual(bug["sections"]["validation"], "- Needed: no. The watch on JP-9001 proves this fix.")
        self.assertEqual(bug["sections"]["goal"], "JP-9001's validation criteria are met in production")
        self.assertEqual(bug["sections"]["first_step"],
                         "Read JP-9001's Validation section and the evidence table in its last comment")
        self.assertIn("3 of 3 checks failed", bug["sections"]["current_behaviour"])
        self.assertEqual(bug["sections"]["parent_or_related"], "JP-9001")
        self.assertIn("Scenario: The retirement job runs clean", bug["sections"]["acceptance_criteria"])
        self.assertIn("Then last_exit is 0", bug["sections"]["acceptance_criteria"])
        from lib import adf
        rendered = adf.to_marked(adf.ticket_description(bug))
        section = validation_section.parse(rendered, "JP-9002")
        self.assertEqual((section["needed"], section["problems"]), ("no", []))

    def test_card_has_one_sentence_first_and_stays_short(self):
        text = copy.card("manual", key=KEY, statements=["the summaries read as plain English"])
        self.assertIn("the summaries read as plain English", text)
        first = text.split("\n")[0]
        self.assertTrue(first.endswith("."))
        self.assertIn(KEY, first)
        long = copy.card("unreadable", key=KEY, problems=[{"found": "x" * 190, "needed": "y" * 190}] * 40)
        self.assertLessEqual(len(long), 4000)

    def test_card_file_is_rewritten(self):
        with tempfile.TemporaryDirectory() as tmp:
            first = copy.write_card(Path(tmp), "First card.\nMore.")
            second = copy.write_card(Path(tmp), "Second card.")
            self.assertEqual(first, second)
            self.assertEqual(Path(second).read_text(), "Second card.\n")
            self.assertEqual(Path(second), Path(tmp) / "watch" / "card.md")


class TheEntryGate(Base):
    def test_entry_gate(self):
        self.site.seed(KEY, "Deployed")
        self.assertEqual(deployed.run({"ticket_key": KEY}, self.deps)[0], "pass")
        self.site.edit(KEY, **{h.FLAG_FIELD: [{"value": "Impediment"}]})
        outcome, outputs, summary = deployed.run({"ticket_key": KEY}, self.deps)
        self.assertEqual(outcome, "refuse")
        self.assertIn("flagged", summary)
        self.site.edit(KEY, **{h.FLAG_FIELD: []})
        self.site.set_status(KEY, "In Progress")
        outcome, _, summary = deployed.run({"ticket_key": KEY}, self.deps)
        self.assertEqual(outcome, "refuse")
        self.assertIn("In Progress", summary)

    def test_a_failed_read_stops_the_start(self):
        with self.assertRaises(GateError):
            deployed.run({"ticket_key": "JP-9404"}, self.deps)


class ReadingTheSection(Base):
    def test_read_validation_three_ways(self):
        self.site.seed(KEY, validation=h.YES)
        outcome, out, _ = read_validation.run({"ticket_key": KEY}, self.deps)
        self.assertEqual(outcome, "watch")
        self.assertEqual((out["needed"], out["check_every_hours"], len(out["criteria"])), ("yes", 1, 1))
        self.assertEqual((out["complete_when"], out["give_up_days"], out["fail_after"], out["starts"]),
                         ("3 checks in a row pass", 2, 3, "at Deployed"))
        self.assertEqual(len(out["section_version"]), 16)
        self.assertEqual(out["problems"], [])

        self.site.seed("JP-9002", validation="")
        outcome, out, summary = read_validation.run({"ticket_key": "JP-9002"}, self.deps)
        self.assertEqual((outcome, out["needed"]), ("not_needed", "no"))
        self.assertIn("no Validation section", summary)

        self.site.seed("JP-9003", validation=h.YES.replace("1 hour", "daily"))
        outcome, out, _ = read_validation.run({"ticket_key": "JP-9003"}, self.deps)
        self.assertEqual((outcome, out["needed"], len(out["problems"])), ("unreadable", "unreadable", 1))
        self.assertIn("Check every: 'daily'", out["problems"][0]["found"])

    def test_needed_no_is_not_needed(self):
        self.site.seed(KEY, validation=h.NO)
        outcome, out, _ = read_validation.run({"ticket_key": KEY}, self.deps)
        self.assertEqual((outcome, out["needed"]), ("not_needed", "no"))

    def test_an_unreadable_ticket_stops_the_run(self):
        with self.assertRaises(GateError):
            read_validation.run({"ticket_key": "JP-9404"}, self.deps)


class TheVerdict(Base):
    def verdict(self, needed="yes", watch_result="met", tally=None, **extra):
        inputs = {"ticket_key": KEY, "needed": needed, "problems": j([]), "criteria": j(CRITERIA),
                  "watch_result": watch_result, "tally": j(GOOD if tally is None else tally)}
        inputs.update(extra)
        return verdict_gate.run(inputs, self.deps)

    def test_verdict_prefers_this_rounds_reading_of_the_section(self):
        self.site.seed(KEY, validation=h.NO)
        outcome, out, _ = self.verdict(needed="no", watch_result="met")
        self.assertEqual(outcome, "not_needed")
        self.assertIn('the ticket says "Needed: no"', out["evidence"])
        self.assertEqual(out["card"], "")

    def test_no_section_says_so(self):
        self.site.seed(KEY, validation="")
        outcome, out, _ = self.verdict(needed="no", watch_result="")
        self.assertEqual((outcome, out["evidence"]), ("not_needed", "the ticket has no Validation section"))

    def test_met(self):
        self.end_line("met", "streak", GOOD)
        outcome, out, _ = self.verdict()
        self.assertEqual(outcome, "met")
        self.assertEqual((out["result"], out["card"], out["failed"]), ("met", "", []))
        self.assertIn("| The retirement job runs clean | 3 | 3 | 0 | 0 |", out["evidence"])

    def test_not_met_names_only_the_failing_criterion(self):
        self.end_line("not_met", "fail_after", BAD)
        outcome, out, _ = self.verdict(watch_result="not_met", tally=BAD)
        self.assertEqual(outcome, "not_met")
        self.assertEqual([f["id"] for f in out["failed"]], ["V1"])

    def test_a_failure_that_has_since_recovered_is_not_a_failed_criterion(self):
        tally = [entry("V1", 5, 3, 2, streak=3), entry("V2", 3, 0, 3)]
        self.end_line("not_met", "gave_up", tally)
        outcome, out, _ = self.verdict(watch_result="not_met", tally=tally)
        self.assertEqual([f["id"] for f in out["failed"]], ["V2"])

    def test_needs_josh_asks_for_the_manual_criterion(self):
        self.end_line("needs_josh", "streak", GOOD)
        outcome, out, _ = self.verdict(watch_result="needs_josh", criteria=j(CRITERIA + [MANUAL]))
        self.assertEqual(outcome, "undecided")
        card = Path(out["card"])
        self.assertTrue(card.is_file())
        self.assertIn("the summaries read as plain English", card.read_text().split("\n")[0])

    def test_no_data_after_giving_up_names_the_criteria_with_no_readings(self):
        tally = [entry("V1", 3, 3, 0, streak=3), entry("V2", 4, 0, 0, unknown=4)]
        self.end_line("no_data", "gave_up", tally)
        outcome, out, _ = self.verdict(watch_result="no_data", tally=tally)
        self.assertEqual(outcome, "undecided")
        text = Path(out["card"]).read_text()
        self.assertIn("The doctor reports no failed check", text)
        self.assertNotIn("The retirement job runs clean", text)

    def test_no_data_when_the_watch_never_began_names_the_starts_line(self):
        self.end_line("no_data", "starts_cancelled", [], starts="after JP-170 is Done")
        outcome, out, _ = self.verdict(watch_result="no_data", tally=[])
        self.assertEqual(outcome, "undecided")
        text = Path(out["card"]).read_text()
        self.assertIn("after JP-170 is Done", text)
        self.assertIn("cancelled", text)

    def test_unreadable_section_quotes_the_line(self):
        problems = [{"item": "V3", "where": "Validation", "found": "Check every: 'daily'",
                     "needed": "Write '<n> hours' or '<n> days', from 1 hour to 7 days."}]
        outcome, out, _ = self.verdict(needed="unreadable", watch_result="met", problems=j(problems))
        self.assertEqual(outcome, "undecided")
        self.assertIn("Check every: 'daily'", Path(out["card"]).read_text())

    def test_card_file_is_rewritten(self):
        self.end_line("no_data", "gave_up", [entry("V1", 1, 0, 0, unknown=1), entry("V2", 1, 3, 0)])
        _, first, _ = self.verdict(watch_result="no_data", tally=[entry("V1", 1, 0, 0, unknown=1)])
        problems = [{"item": "V5", "where": "Validation", "found": "When the watch reads weather today",
                     "needed": "Use a collector from the list."}]
        _, second, _ = self.verdict(needed="unreadable", problems=j(problems))
        self.assertEqual(first["card"], second["card"])
        self.assertIn("weather today", Path(second["card"]).read_text())
        self.assertNotIn("no reading", Path(second["card"]).read_text())


if __name__ == "__main__":
    unittest.main()
