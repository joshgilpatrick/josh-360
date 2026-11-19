"""JP-167, Task 10: close-watch, file-validation-bug and hold-watch. Made-up tickets, a made-up clock, no network.

Run: python3 -m unittest discover -s graphs/tests -p "test_validation_writes.py"   (from the repository root)
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import validation_gate_helpers as h
from validation_gate_helpers import KEY, Site, load_gate

from lib import validation_copy as copy
from lib.gate_run import GateError
from lib.watch import log, round as watch_round

close_watch = load_gate("close-watch")
file_bug = load_gate("file-validation-bug")
hold_watch = load_gate("hold-watch")

CRITERIA = [{"id": "V1", "name": "The sample job runs clean", "collector": "job", "argument": "sample-job",
             "checks": [{"field": "last_exit", "comparison": "is", "value": 0}], "manual": False, "statement": ""}]
GOOD = [{"id": "V1", "checks": 3, "passed": 3, "failed": 0, "unknown": 0, "streak": 3, "last": {"last_exit": 0},
         "link": ""}]
BAD = [{"id": "V1", "checks": 3, "passed": 0, "failed": 3, "unknown": 0, "streak": 0, "last": {"last_exit": 1},
        "link": ""}]


class Base(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.site = Site(tmp.name)
        self.deps = self.site.deps
        self.site.seed()
        self.folder = self.deps.work_dir / "watch"

    def round_file(self, n=1, criteria=CRITERIA, checks=3, **plan):
        path = self.folder / "round-{}.json".format(n)
        watch_round.write_plan(path, dict({"ticket_key": KEY, "round": n, "criteria": criteria,
                                           "complete_when": "3 checks in a row pass"}, **plan))
        for i in range(1, checks + 1):
            log.append(log.path_for(path), {"kind": "check", "at": "2026-11-18T1{}:00:00Z".format(i), "n": i,
                                            "result": "pass", "criteria": {}})
        return path

    def issues_of_type(self, name):
        return [k for k in self.site.keys() if self.site.issue(k)["issuetype"]["name"] == name]


class Closing(Base):
    def close(self, result, evidence, **extra):
        return close_watch.run(dict({"ticket_key": KEY, "result": result, "evidence": evidence,
                                     "target_status": "Done"}, **extra), self.deps)

    def test_close_met_posts_evidence_and_moves_to_done(self):
        self.round_file(checks=9)
        table = copy.evidence_table(CRITERIA, GOOD)
        outcome, _, _ = self.close("met", table)
        self.assertEqual(outcome, "closed")
        last = self.site.comment_texts(KEY)[-1]
        self.assertTrue(last.startswith(
            "Validated in production | 3 checks in a row pass, reached on check 9 of round 1 | next gate: none."))
        self.assertTrue(last.endswith(table))
        self.assertEqual(self.site.status(KEY), "Done")

    def test_closing_twice_posts_once(self):
        self.round_file()
        self.close("met", "table")
        self.site.set_status(KEY, "Deployed")
        self.close("met", "table")
        self.assertEqual(len(self.site.comment_texts(KEY)), 1)

    def test_close_unwatched_says_why(self):
        self.close("not_needed", copy.no_section())
        self.assertEqual(self.site.comment_texts(KEY)[-1],
                         "Nothing to watch | the ticket has no Validation section | next gate: none.")
        self.assertEqual(self.site.status(KEY), "Done")

    def test_close_accepted_quotes_the_card(self):
        copy.write_card(self.deps.work_dir, "No readings came back for the sample job.\nMore detail.")
        table = copy.evidence_table(CRITERIA, BAD)
        self.close("undecided", table)
        last = self.site.comment_texts(KEY)[-1]
        today = self.site.clock.astimezone().strftime("%Y-%m-%d")
        self.assertTrue(last.startswith(
            "Closed on Josh's answer ({}) | the watch had not shown the criteria met: No readings came back for the "
            "sample job. | next gate: none.".format(today)))
        self.assertTrue(last.endswith(table))
        self.assertEqual(self.site.status(KEY), "Done")

    def test_close_accepted_with_no_evidence_still_closes(self):
        copy.write_card(self.deps.work_dir, "The section could not be read.")
        self.close("undecided", "")
        self.assertEqual(self.site.status(KEY), "Done")
        self.assertNotIn("\n", self.site.comment_texts(KEY)[-1])

    def test_close_leaves_a_moved_ticket_alone(self):
        self.site.set_status(KEY, "In Progress")
        outcome, _, summary = self.close("met", "table")
        self.assertEqual(outcome, "closed")
        self.assertIn("already left Deployed", summary)
        self.assertEqual(self.site.writes(), [])
        self.assertEqual(self.site.status(KEY), "In Progress")

    def test_close_stops_when_the_move_did_not_take(self):
        self.round_file()
        with self.assertRaises(GateError):
            self.close("met", "table", target_status="Shipped")
        self.assertEqual(self.site.status(KEY), "Deployed")

    def test_close_stops_when_the_status_cannot_be_read(self):
        with self.assertRaises(GateError):
            close_watch.run({"ticket_key": "JP-9404", "result": "met", "evidence": "", "target_status": "Done"},
                            self.deps)

    def test_close_screens_what_it_writes(self):
        self.round_file()
        with self.assertRaises(GateError):
            self.close("met", "Patient: Jane Doe was seen")
        self.assertEqual(self.site.status(KEY), "Deployed")


class FilingTheBug(Base):
    def setUp(self):
        super().setUp()
        self.round_file()

    def file(self, failed=BAD, evidence=None, deps=None):
        return file_bug.run({"ticket_key": KEY, "failed": json.dumps(failed),
                             "evidence": evidence or copy.evidence_table(CRITERIA, BAD)}, deps or self.deps)

    def test_bug_is_filed_linked_and_announced(self):
        outcome, outputs, _ = self.file()
        self.assertEqual(outcome, "filed")
        bugs = self.issues_of_type("Bug")
        self.assertEqual(bugs, [outputs["bug_key"]])
        bug = self.site.issue(bugs[0])
        self.assertEqual(bug["status"]["name"], "Not Started")
        self.assertEqual(sorted(bug["labels"]), ["josh-360", "validation-failure"])
        self.assertEqual(bug["summary"], "JP-9001 did not meet its validation: The sample job runs clean")
        links = self.site.issue(KEY)["issuelinks"]
        self.assertEqual([l["outwardIssue"]["key"] for l in links], bugs)
        last = self.site.comment_texts(KEY)[-1]
        self.assertTrue(last.startswith("Not met in production | The sample job runs clean: 3 of 3 checks failed | "
                                        "next gate: {}; the watch starts again when it ships.".format(bugs[0])))
        self.assertIn("| The sample job runs clean | 3 | 0 | 3 |", last)
        self.assertEqual(self.site.status(KEY), "Deployed")

    def test_a_ticket_that_left_deployed_gets_no_bug_and_no_comment(self):
        """The watch can end not_met on its give-up time with no fresh look at the ticket."""
        self.site.set_status(KEY, "In Progress")
        outcome, outputs, summary = self.file()
        self.assertEqual((outcome, outputs), ("left_deployed", None))
        self.assertIn("already left Deployed", summary)
        self.assertEqual(self.site.writes(), [])
        self.assertEqual(self.issues_of_type("Bug"), [])
        self.assertFalse((self.folder / "bug.json").exists())

    def test_open_linked_bug_is_reused(self):
        first = self.file()[1]["bug_key"]
        self.file()
        self.assertEqual(len(self.site.comment_texts(KEY)), 1)
        (self.folder / "bug.json").unlink()
        fresh = type(self.deps)(**vars(self.deps))
        fresh.work_dir = self.tmp / "fresh-run" / "work"
        again = self.file(deps=fresh)[1]["bug_key"]
        self.assertEqual((again, self.issues_of_type("Bug")), (first, [first]))

    def test_a_closed_bug_is_not_reused_by_a_later_round(self):
        first = self.file()[1]["bug_key"]
        self.site.set_status(first, "Done")
        self.round_file(2)
        second = self.file()[1]["bug_key"]
        self.assertNotEqual(first, second)
        self.assertEqual(len(self.issues_of_type("Bug")), 2)

    def test_crash_after_create_does_not_file_twice(self):
        self.site.transport.fail_once.append("/issueLink")
        with self.assertRaises(GateError):
            self.file()
        self.assertEqual(len(self.issues_of_type("Bug")), 1)
        self.assertEqual(self.site.comment_texts(KEY), [])
        outcome, outputs, _ = self.file()
        self.assertEqual(outcome, "filed")
        self.assertEqual(self.issues_of_type("Bug"), [outputs["bug_key"]])
        self.assertEqual(len(self.site.comment_texts(KEY)), 1)

    def test_a_create_jira_did_not_confirm_stops_the_run_with_no_comment(self):
        self.site.transport.fail_once.append("/rest/api/3/issue")
        with self.assertRaises(GateError):
            self.file()
        self.assertEqual(self.issues_of_type("Bug"), [])
        self.assertEqual(self.site.comment_texts(KEY), [])
        self.assertFalse((self.folder / "bug.json").exists())

    def test_bug_text_is_screened(self):
        named = [dict(CRITERIA[0], name="Patient: Jane Doe reads well")]
        self.round_file(criteria=named)
        with self.assertRaises(GateError):
            self.file()
        self.assertEqual(self.issues_of_type("Bug"), [])

    def test_an_unreadable_link_stops_the_run_instead_of_filing_a_second_bug(self):
        self.site.edit(KEY, issuelinks=[{"type": {"name": "Relates"}, "outwardIssue": {"key": "JP-9404"}}])
        with self.assertRaises(GateError):
            self.file()
        self.assertEqual(self.issues_of_type("Bug"), [])

    def test_a_linked_bug_that_is_not_a_validation_failure_does_not_count(self):
        self.site.seed("JP-9003", "Not Started", issuetype="Bug", labels=("josh-360",))
        self.site.edit(KEY, issuelinks=[{"type": {"name": "Relates"}, "outwardIssue": {"key": "JP-9003"}}])
        self.file()
        self.assertEqual(len(self.issues_of_type("Bug")), 2)


class Holding(Base):
    def test_hold_flags_and_explains(self):
        outcome, _, _ = hold_watch.run({"ticket_key": KEY}, self.deps)
        self.assertEqual(outcome, "held")
        self.assertTrue(self.site.flagged(KEY))
        self.assertEqual(self.site.comment_texts(KEY), [copy.hold()])
        self.assertEqual(self.site.status(KEY), "Deployed")
        hold_watch.run({"ticket_key": KEY}, self.deps)
        self.assertEqual(len(self.site.comment_texts(KEY)), 1)

    def test_hold_leaves_a_moved_ticket_alone(self):
        self.site.set_status(KEY, "In Progress")
        outcome, _, summary = hold_watch.run({"ticket_key": KEY}, self.deps)
        self.assertEqual(outcome, "held")
        self.assertIn("already left Deployed", summary)
        self.assertEqual(self.site.writes(), [])
        self.assertFalse(self.site.flagged(KEY))

    def test_hold_stops_when_the_status_cannot_be_read(self):
        with self.assertRaises(GateError):
            hold_watch.run({"ticket_key": "JP-9404"}, self.deps)


if __name__ == "__main__":
    unittest.main()
