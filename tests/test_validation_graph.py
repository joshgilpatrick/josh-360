"""JP-167: whole runs of the validation graph, through the real walker and the real gate scripts.

Jira is a folder-backed fake and the job collector reads a made-up jobs-state.json; nothing uses a model or the
network, and every ticket and key is invented. A test lets time pass by moving the run's watch files back
(`ValidationCase.age`), because the gate scripts read the clock themselves.

Run: python3 -m unittest discover -s tests -t tests -p "test_validation_graph.py"   (from the repository root)
"""
import json
import re
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

import validation_helpers as v
from validation_helpers import BUG, KEY, ValidationCase
from walker_helpers import ROOT

sys.path.insert(0, str(ROOT / "graphs" / "gates"))
import validation_gate_helpers as g  # noqa: E402
from lib import collectors, validation_section  # noqa: E402
from lib.collectors import reading  # noqa: E402
from lib.watch import grading  # noqa: E402

DRAFT = ROOT / "docs" / "superpowers" / "specs" / "2026-11-18-post-deploy-validation-draft"
ANOTHER = g.YES.replace("The sample job runs clean", "The other job runs clean").replace("sample-job", "other-job")


class Finishing(ValidationCase):
    def test_met_run_ends_finished(self):
        self.ticket()
        self.job_state("sample-job", 0)
        run = self.begin()
        self.assertEqual(self.walk(run)["action"], "waiting")
        self.assertEqual([self.checks(run)["action"] for _ in range(3)], ["waiting", "waiting", "done"])
        self.assertEqual(self.end_of(run), "finished")
        self.assertEqual(self.status(), "Done")
        last = self.comments()[-1]
        self.assertTrue(last.startswith("Validated in production | 3 checks in a row pass, reached on check 3 of round 1"))
        self.assertIn("| The sample job runs clean | 3 | 3 | 0 | 0 |", last)

    def test_no_section_goes_straight_to_done(self):
        self.ticket(validation="")
        run = self.begin()
        self.assertEqual(self.walk(run)["action"], "done")
        self.assertEqual(self.end_of(run), "close_unwatched.closed")
        self.assertEqual(self.comments()[-1], "Nothing to watch | the ticket has no Validation section | next gate: none.")
        self.assertEqual(self.status(), "Done")

    def test_needed_no_goes_to_done_with_its_reason(self):
        self.ticket(validation=g.NO)
        run = self.begin()
        self.assertEqual(self.walk(run)["action"], "done")
        self.assertEqual(self.end_of(run), "close_unwatched.closed")
        self.assertTrue(self.comments()[-1].startswith('Nothing to watch | the ticket says "Needed: no": '))
        self.assertIn("nothing runs in production", self.comments()[-1])
        self.assertEqual(self.status(), "Done")

    def test_run_passes_the_exit_gate_with_no_session(self):
        self.ticket(validation="")
        run = self.begin()
        done = self.walk(run)
        self.assertEqual((done["action"], done["score"]), ("done", "neutral"))
        self.assertNotEqual(self.end_of(run), "exit_refused")


class WhenItFails(ValidationCase):
    def fail_round(self, run, n=3):
        self.job_state("sample-job", 1)
        self.walk(run)
        return self.checks(run, n)

    def test_failed_watch_files_one_bug_and_stays_deployed(self):
        self.ticket()
        run = self.begin()
        waiting = self.fail_round(run)
        self.assertEqual((waiting["action"], waiting["step"]), ("waiting", "await_fix"))
        (bug,) = self.bugs()
        fields = self.site.issue(bug)
        self.assertEqual(sorted(fields["labels"]), ["josh-360", "validation-failure"])
        self.assertEqual([l["outwardIssue"]["key"] for l in self.site.issue(KEY)["issuelinks"]], [bug])
        self.assertEqual(self.status(), "Deployed")
        self.assertTrue(self.comments()[-1].startswith("Not met in production | The sample job runs clean: 3 of 3 checks failed"))
        self.assertEqual(self.walk(run)["step"], "await_fix")
        self.assertEqual(len(self.bugs()), 1)

    def test_shipped_fix_reads_the_section_again(self):
        self.ticket()
        run = self.begin()
        self.fail_round(run)
        (bug,) = self.bugs()
        first = json.loads((self.watch_folder(run) / "round-1.json").read_text())
        self.site.set_validation(KEY, g.YES.replace("3 checks", "2 checks"))
        self.site.set_status(bug, "Done")
        self.age(run, 1)
        out = self.walk(run)
        self.assertEqual((out["action"], out["step"]), ("waiting", "watch"))
        second = json.loads((self.watch_folder(run) / "round-2.json").read_text())
        self.assertEqual((second["round"], second["complete_n"]), (2, 2))
        self.assertNotEqual(second["section_version"], first["section_version"])

    def test_second_shipped_fix_asks_josh(self):
        self.ticket()
        run = self.begin()
        self.fail_round(run)
        (first,) = self.bugs()
        self.site.set_status(first, "Done")
        self.age(run, 1)
        self.assertEqual(self.walk(run)["step"], "watch")
        self.checks(run, 3)
        second = [b for b in self.bugs() if b != first]
        self.assertEqual(len(second), 1)
        self.site.set_status(second[0], "Done")
        self.age(run, 1)
        out = self.walk(run)
        self.assertEqual((out["action"], out["step"]), ("parked", "decide"))
        card = self.question(run)["questions"][0]
        text = json.dumps(card)
        self.assertIn(second[0], text)
        self.assertIn("2 rounds", text)
        self.assertIn("round 1", text)
        self.assertIn("round 2", text)

    def test_cancelled_fix_asks_josh(self):
        self.ticket()
        run = self.begin()
        self.fail_round(run)
        (bug,) = self.bugs()
        self.site.set_status(bug, "Cancelled")
        self.age(run, 1)
        out = self.walk(run)
        self.assertEqual((out["action"], out["step"]), ("parked", "decide"))
        text = json.dumps(self.question(run)["questions"][0])
        self.assertIn(bug + " was cancelled", text)
        self.assertIn("The sample job runs clean", text)


class AskingJosh(ValidationCase):
    def no_data(self, run):
        self.walk(run)
        self.age(run, 49)
        return self.walk(run)

    def test_no_data_asks_josh_once(self):
        self.ticket()
        run = self.begin()
        out = self.no_data(run)
        self.assertEqual((out["action"], out["step"]), ("parked", "decide"))
        record = self.question(run)
        text = json.dumps(record["questions"][0])
        self.assertIn("The watch on " + KEY + " cannot finish on its own", text)
        self.assertIn("The sample job runs clean", text)
        self.assertEqual(self.walk(run)["action"], "parked")
        self.assertEqual(len(list((self.tmp / "questions").glob("*.json"))), 1)

    def test_unreadable_section_asks_josh(self):
        self.ticket(validation=g.YES.replace("1 hour", "daily"))
        run = self.begin()
        out = self.walk(run)
        self.assertEqual((out["action"], out["step"]), ("parked", "decide"))
        self.assertIn("could not be read", json.dumps(self.question(run)["questions"][0]))
        # the walker flags a ticket that is waiting on Josh; nothing else is written to it
        self.assertEqual([w for w in self.writes() if "customfield_10021" not in json.dumps(w["body"])], [])
        self.assertEqual((self.status(), self.comments()), ("Deployed", []))

    def test_manual_criterion_asks_josh_when_the_rest_is_met(self):
        self.ticket(validation=g.MANUAL)
        self.job_state("sample-job", 0)
        run = self.begin()
        self.walk(run)
        out = self.checks(run, 2)
        self.assertEqual((out["action"], out["step"]), ("parked", "decide"))
        self.assertIn("the summaries read as plain English", json.dumps(self.question(run)["questions"][0]))
        self.assertEqual(self.status(), "Deployed")

    def test_watch_again_shows_the_new_card(self):
        self.ticket()
        run = self.begin()
        self.no_data(run)
        self.answer_in_app(run, "decide", "watch_again")
        self.site.set_validation(KEY, ANOTHER)
        self.age(run, 1)
        out = self.walk(run)
        self.assertEqual((out["action"], out["step"]), ("waiting", "watch"))
        self.age(run, 49)
        out = self.walk(run)
        self.assertEqual((out["action"], out["step"]), ("parked", "decide"))
        text = json.dumps(self.question(run, attempt=2)["questions"][0])
        self.assertIn("The other job runs clean", text)
        self.assertNotIn("The sample job runs clean", text)

    def test_accept_closes_on_joshs_answer(self):
        self.ticket()
        run = self.begin()
        self.no_data(run)
        self.answer_in_app(run, "decide", "accept")
        self.assertEqual(self.walk(run)["action"], "done")
        self.assertEqual(self.end_of(run), "close_accepted.closed")
        self.assertTrue(self.comments()[-1].startswith("Closed on Josh's answer"))
        self.assertEqual(self.status(), "Done")

    def test_stop_holds_the_ticket(self):
        self.ticket()
        run = self.begin()
        self.no_data(run)
        self.answer_in_app(run, "decide", "stop")
        self.assertEqual(self.walk(run)["action"], "done")
        self.assertEqual(self.end_of(run), "hold.held")
        self.assertTrue(self.site.flagged(KEY))
        self.assertEqual(self.status(), "Deployed")


class LeavingItAlone(ValidationCase):
    def test_ticket_moved_by_hand_is_left_alone(self):
        self.ticket()
        self.job_state("sample-job", 0)
        run = self.begin()
        self.assertEqual(self.walk(run)["action"], "waiting")
        self.site.set_status(KEY, "In Progress")
        before = self.writes()
        for _ in range(3):
            self.assertEqual(self.walk(run)["action"], "waiting")
        self.age(run, 1)
        done = self.walk(run)
        self.assertEqual(done["action"], "done")
        self.assertEqual(self.end_of(run), "watch.left_deployed")
        self.assertEqual(self.writes(), before)
        self.assertEqual(self.status(), "In Progress")
        self.assertFalse(self.site.flagged(KEY))


class TheGraphFile(unittest.TestCase):
    def compiled(self):
        return json.loads((ROOT / "graphs" / "compiled" / "validation.json").read_text())["graph"]

    def test_no_step_has_a_role(self):
        steps = self.compiled()["steps"]
        kinds = {s["id"]: ("gate" if "gate" in s else "wait" if "wait" in s else "ask" if "ask" in s else "role")
                 for s in steps}
        self.assertEqual(sorted(k for k, kind in kinds.items() if kind == "role"), [])
        self.assertEqual(len(steps), 11)

    def test_declared_collectors_are_the_reader_modules(self):
        folder = ROOT / "graphs" / "gates" / "lib" / "collectors"
        modules = sorted(p.stem for p in folder.glob("*.py") if p.stem not in ("__init__", "reading"))
        self.assertEqual(modules, sorted(n.replace("-", "_") for n in collectors.DECLARED))
        examples = {"job": "sample-job", "report": "doctor summary.fail", "doctor": "graphs.compiled",
                    "ledger-runs": "triage", "jira-count": "project = JP", "github-runs": "o/r ci.yml"}
        deps = SimpleNamespace(environ={}, now=None, jira=None, work_dir=None)
        for name, entry in collectors.DECLARED.items():
            module = __import__("lib.collectors." + name.replace("-", "_"), fromlist=["x"])
            self.assertEqual(dict(module.FIELDS), entry["fields"], name)
            self.assertEqual(module.COUNTS_EVENTS, entry["counts_events"], name)
            self.assertEqual(module.ARGUMENT.pattern, entry["argument"], name)
            self.assertTrue(validation_section.argument_ok(name, examples[name]), name)
            bad = examples[name] + "\n"
            self.assertFalse(validation_section.argument_ok(name, bad), name)
            got = module.read(bad, "", deps)
            self.assertEqual(got["fields"], {field: None for field in entry["fields"]}, name)
        self.assertEqual(reading.CODE.pattern, collectors.CODE.pattern)

    def test_every_comparison_is_graded(self):
        for comparison in collectors.COMPARISONS:
            self.assertIsNotNone(grading.holds(1, comparison, 1), comparison)

    def test_the_draft_folder_is_gone(self):
        self.assertFalse(DRAFT.exists())


if __name__ == "__main__":
    unittest.main()
