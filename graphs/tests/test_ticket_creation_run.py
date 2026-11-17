"""JP-121: the whole ticket creation graph, walked with the real walker and the real gate scripts.

Only two things are made up: the roles' answers (a test writes each role's result file, as an agent would) and Jira
(a folder-backed fake, JOSH360_JIRA_FAKE, that records every request). Every record, text and key here is invented.

Run: python3 -m unittest discover -s graphs/tests   (from the repository root)
"""
from __future__ import annotations

import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

import ticket_creation_helpers as h

ROOT = h.ROOT
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "graphs" / "tools"))
sys.path.insert(0, str(ROOT / "graphs" / "intake"))
from ledger import _repo  # noqa: E402,F401
from ledger import db  # noqa: E402
from walker_lib import cli, questions  # noqa: E402
import submit  # noqa: E402

NOW = "2026-11-17T12:00:00Z"


class RunCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="josh360-intake-"))
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.saved = dict(os.environ)
        self.addCleanup(self._restore)
        home = self.tmp / "home"
        self.fake = self.tmp / "jira"
        self.fake.mkdir()
        (self.fake / "fake-jira.json").write_text("{}")
        for var in [k for k in os.environ if k.startswith(("JOSH360_", "DESK_", "GRAPH_INPUT_"))]:
            os.environ.pop(var)
        os.environ.update({"JOSH360_HOME": str(home), "JOSH360_RUNS": str(self.tmp / "runs"),
                           "JOSH360_QUESTIONS_DIR": str(self.tmp / "questions"),
                           "JOSH360_JIRA_FAKE": str(self.fake), "JOSH360_ACTION_ITEMS": str(self.tmp / "items.json"),
                           "DESK_DB": str(self.tmp / "desk.db")})
        db.ensure(home / "state" / "ledger.db", home / "backups", NOW)
        h.action_items(self.tmp, h.todo())
        os.replace(str(self.tmp / "action-items.json"), str(self.tmp / "items.json"))

    def _restore(self):
        os.environ.clear()
        os.environ.update(self.saved)

    # -- the walker --------------------------------------------------------------------------------------------
    def walker(self, *argv, code=0):
        out = io.StringIO()
        got = cli.main(["--root", str(ROOT / "graphs")] + [str(a) for a in argv], out)
        self.assertEqual(got, code, out.getvalue())
        return json.loads(out.getvalue())

    def start(self, ref="todo-0007", source="todo"):
        return submit.start(source, ref)

    def role(self, run, step, outcome, outputs):
        out = self.walker("next", "--run", run)
        self.assertEqual((out["action"], out["step"]), ("run", step), out)
        result = Path(out["result_file"])
        result.write_text(json.dumps({"outcome": outcome, "outputs": outputs}))
        self.walker("record", "--run", run, "--step", step, "--result-file", result)
        return out

    def answer(self, run, step, text, attempt=1):
        qid = questions.question_id(run, step, attempt)
        path = self.tmp / "questions" / (qid + ".json")
        record = json.loads(path.read_text())
        record["state"] = "answered"
        record["answers"] = {record["questions"][0]["question"]: text}
        path.write_text(json.dumps(record))

    # -- the made-up role answers ------------------------------------------------------------------------------
    def file(self, name, value):
        return h.write_json(self.tmp / name, value)

    def intake(self, **over):
        record = h.clone(h.RECORD)
        record.update(over)
        return self.file("intake.json", record)

    def read_and_search(self, run, record=None, candidates=None):
        self.role(run, "read_intake", "recorded", {"intake_record": record or self.intake()})
        self.role(run, "find_duplicates", "searched", {"candidates": candidates or []})

    # -- what Jira saw -----------------------------------------------------------------------------------------
    def calls(self):
        path = self.fake / "calls.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.is_file() else []

    def writes(self):
        return [c for c in self.calls() if c["method"] != "GET" and c["path"] != "/rest/api/3/search/jql"]

    def state(self):
        return json.loads((self.fake / "fake-jira.json").read_text())

    def items(self):
        return json.loads((self.tmp / "items.json").read_text())["todos"][0]


class ALightRequestBecomesOneTicket(RunCase):
    def test_light_todo_to_one_ticket(self):
        run = self.start()
        self.read_and_search(run)
        self.role(run, "draft", "drafted", {"proposal": self.file("proposal.json", h.proposal())})
        parked = self.walker("next", "--run", run)
        self.assertEqual((parked["action"], parked["step"]), ("parked", "approve"), parked)
        self.answer(run, "approve", "approve")
        done = self.walker("next", "--run", run)
        self.assertEqual((done["action"], done["end"], done["score"]), ("done", "finished", "success"), done)
        issues = self.state()["issues"]
        self.assertEqual(list(issues), ["JP-201"])
        self.assertEqual(issues["JP-201"]["fields"]["status"], {"name": "Not Started"})
        self.assertEqual(self.items()["ticketKey"], "JP-201")


    def test_nothing_is_written_before_approval(self):
        run = self.start()
        self.read_and_search(run)
        self.role(run, "draft", "drafted", {"proposal": self.file("proposal.json", h.proposal())})
        parked = self.walker("next", "--run", run)
        self.assertEqual(parked["step"], "approve")
        self.assertEqual(self.writes(), [])                      # not one write has reached Jira
        self.assertEqual(self.state().get("issues", {}), {})
        self.assertIn("Create", json.dumps(json.loads(
            (self.tmp / "questions" / (questions.question_id(run, "approve", 1) + ".json")).read_text())))

    def test_the_created_ticket_is_not_ready_and_carries_its_authors(self):
        run = self.start()
        self.read_and_search(run)
        self.role(run, "draft", "drafted", {"proposal": self.file("proposal.json", h.proposal())})
        self.walker("next", "--run", run)
        self.answer(run, "approve", "approve")
        self.walker("next", "--run", run)
        state = self.state()
        self.assertEqual(state["issues"]["JP-201"]["fields"]["status"], {"name": "Not Started"})
        self.assertEqual([w for w in self.writes() if w["path"].endswith("/transitions")], [])
        fields = [w["body"]["fields"] for w in self.writes() if w["path"] == "/rest/api/3/issue"]
        self.assertEqual(len(fields), 1)
        for forbidden in ("priority", "assignee", "duedate", "customfield_10452", "customfield_10453"):
            self.assertNotIn(forbidden, fields[0])
        self.assertEqual(state["properties"]["JP-201|josh360.authors"], ["session-a", "session-b"])
        self.assertEqual(state["properties"]["JP-201|action-triage.spec"], {"type": "code"})


def candidate(key, status):
    return {"key": key, "summary": "Same request", "status": status, "is_match": True, "why": "same deliverable"}


class DuplicatesAndHomes(RunCase):
    def test_an_open_duplicate_gets_a_comment_and_no_ticket(self):
        run = self.start()
        self.read_and_search(run, candidates=[candidate("AD-412", "In Progress")])
        proposal = {"action": "comment_on_match", "gaps": [], "authors": ["session-a"],
                    "match": {"key": "AD-412", "status": "In Progress", "request": "The export drops rows."}}
        self.role(run, "draft", "drafted", {"proposal": self.file("proposal.json", proposal)})
        self.assertEqual(self.walker("next", "--run", run)["step"], "approve")
        self.answer(run, "approve", "approve")
        done = self.walker("next", "--run", run)
        self.assertEqual((done["action"], done["score"]), ("done", "success"), done)
        self.assertEqual(self.state()["issues"], {})
        self.assertEqual(len(self.state()["comments"]["AD-412"]), 1)
        self.assertEqual(self.items()["ticketKey"], "AD-412")    # the item points at the ticket that has the work

    def test_a_finished_duplicate_gets_a_new_ticket_linked_to_it(self):
        run = self.start()
        self.read_and_search(run, candidates=[candidate("JP-3", "Done")])
        proposal = h.proposal(match={"key": "JP-3", "status": "Done"})
        self.role(run, "draft", "drafted", {"proposal": self.file("proposal.json", proposal)})
        self.walker("next", "--run", run)
        self.answer(run, "approve", "approve")
        done = self.walker("next", "--run", run)
        self.assertEqual(done["score"], "success", done)
        links = [w["body"] for w in self.writes() if w["path"] == "/rest/api/3/issueLink"]
        self.assertEqual([(l["type"]["name"], l["inwardIssue"]["key"]) for l in links], [("Relates", "JP-3")])

    def test_when_no_rule_gives_a_home_josh_is_asked_and_nothing_is_written(self):
        run = self.start()
        record = self.intake(repository={"value": "no-such-repository", "basis": "stated"})
        self.read_and_search(run, record=record)
        homeless = h.proposal(route={"space": "JP", "parent": None, "area": None, "system": None, "priority": None,
                                     "labels": [], "rule": "fallback"})
        self.role(run, "draft", "drafted", {"proposal": self.file("proposal.json", homeless)})
        parked = self.walker("next", "--run", run)
        self.assertEqual((parked["action"], parked["step"]), ("parked", "ask_gap"), parked)
        self.assertEqual(self.writes(), [])
        self.answer(run, "ask_gap", "drop")
        done = self.walker("next", "--run", run)
        self.assertEqual((done["action"], done["score"]), ("done", "neutral"), done)


class LimitsAndRepeats(RunCase):
    def test_the_same_item_is_not_filed_twice(self):
        run = self.start()
        with self.assertRaises(submit.Refused) as why:           # a run on it is still open
            self.start()
        self.assertIn("did not admit", str(why.exception))
        self.read_and_search(run)
        self.role(run, "draft", "drafted", {"proposal": self.file("proposal.json", h.proposal())})
        self.walker("next", "--run", run)
        self.answer(run, "approve", "approve")
        self.walker("next", "--run", run)
        with self.assertRaises(submit.Refused):                  # the run ended and the item now carries its ticket
            self.start()

    def test_a_pointer_that_is_text_never_starts_a_run(self):
        with self.assertRaises(submit.Refused):
            submit.start("todo", "Please add a dry-run flag to the install script")

    def test_draft_runs_are_capped_at_three_and_the_fourth_goes_to_stuck(self):
        run = self.start()
        self.read_and_search(run)
        incomplete = h.proposal(tickets=[h.ticket(sections=h.section_set(first_step=""))])
        for attempt in (1, 2, 3):
            out = self.role(run, "draft", "drafted", {"proposal": self.file("proposal.json", incomplete)})
            self.assertEqual(out["attempt"], attempt)
            if attempt > 1:
                self.assertTrue(out["so_far"]["problems"])       # the re-run is told what was wrong
        parked = self.walker("next", "--run", run)
        self.assertEqual((parked["action"], parked["step"]), ("parked", "stuck"), parked)
        self.answer(run, "stuck", "drop")
        done = self.walker("next", "--run", run)
        self.assertEqual((done["action"], done["score"]), ("done", "needs-josh"), done)
        self.assertEqual(self.writes(), [])


if __name__ == "__main__":
    unittest.main()
