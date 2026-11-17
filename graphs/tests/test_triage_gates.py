"""JP-122: each triage gate script on its own, against the folder-backed fake Jira, in-process with its own Deps.

Every ticket, key and session is invented. Run: python3 -m unittest discover -s graphs/tests (from the repository root).
"""
from __future__ import annotations

import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

import ticket_creation_helpers as h
import triage_helpers as t

from lib.gate_run import Deps, GateError
from lib.triage import copy, port

KEY = "JP-9001"
RUN = "r-gate-test"


class GateCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="josh360-triage-gates-"))
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.fake = self.tmp / "jira"
        self.fake.mkdir()
        self.saved = dict(os.environ)
        self.addCleanup(self._restore)
        for var in [k for k in os.environ if k.startswith(("JOSH360_", "ACTION_AGENT_", "GRAPH_INPUT_"))]:
            os.environ.pop(var)
        os.environ.update({"JOSH360_JIRA_FAKE": str(self.fake), "JOSH360_RUNS": str(self.tmp / "runs"),
                           "JOSH360_RUN_ID": RUN, "JOSH360_HOME": str(self.tmp / "home")})
        self.signer = "s-signer"
        self.seed([t.issue(), t.issue("JP-94", type_="Epic", desc=None)])

    def _restore(self):
        os.environ.clear()
        os.environ.update(self.saved)

    def seed(self, issues, properties=None, comments=None, changelogs=None):
        state = t.seed(self.fake, issues, properties, comments)
        if changelogs:
            state["changelogs"] = changelogs
            (self.fake / "fake-jira.json").write_text(json.dumps(state))

    def state(self):
        return json.loads((self.fake / "fake-jira.json").read_text())

    def calls(self):
        path = self.fake / "calls.jsonl"
        return [json.loads(x) for x in path.read_text().splitlines()] if path.is_file() else []

    def writes(self):
        return [c for c in self.calls() if c["method"] != "GET" and c["path"] != "/rest/api/3/search/jql"]

    def gate(self, name, **inputs):
        module = h.load_gate(name)
        deps = Deps()
        deps.signing_session = lambda run_id: self.signer
        return module.run({k: (v if isinstance(v, str) or v is None else json.dumps(v)) for k, v in inputs.items()}, deps)

    def version(self, key=KEY):
        return port.read_ticket(Deps().jira, key, subtasks=False).version


class TheEntryGate(GateCase):
    def queued(self):
        return {KEY: [{"created": "2026-11-17T10:00:00.000+0000", "author": {"accountId": t.ME}, "items": [
            {"field": "Agent Status", "fieldId": "customfield_10453", "fromString": None, "toString": "Queued"}]}]}

    def test_an_own_ticket_is_admitted(self):
        self.assertEqual(self.gate("triageable", ticket_key=KEY)[0], "pass")

    def test_refusals_say_why(self):
        self.seed([t.issue(status="Ready")])
        self.assertIn("not Not Started", self.gate("triageable", ticket_key=KEY)[2].replace("in Ready, ", ""))
        self.seed([t.issue(type_="Epic")])
        self.assertIn("never enters triage", self.gate("triageable", ticket_key=KEY)[2])
        self.seed([t.issue(creator=t.OTHER)])
        self.assertIn("nobody queued", self.gate("triageable", ticket_key=KEY)[2])

    def test_someone_elses_ticket_josh_queued_is_admitted(self):
        self.seed([t.issue(creator=t.OTHER)], changelogs=self.queued())
        self.assertEqual(self.gate("triageable", ticket_key=KEY)[0], "pass")

    def test_triages_own_comment_does_not_start_a_run(self):
        comments = {KEY: [{"id": "1", "body": "Triage: revised by the ticket drafter, round 1 of 2 | run r-0 | next gate: Ready check",
                           "created": "2026-11-17T11:00:00.000+0000"}]}
        self.seed([t.issue()], comments=comments)
        outcome, _, why = self.gate("triageable", ticket_key=KEY)
        self.assertEqual(outcome, "refuse")
        self.assertIn("nothing has changed", why)

    def test_an_edit_after_triages_comment_starts_one(self):
        comments = {KEY: [{"id": "1", "body": "Triage: not Ready yet | run r-0 | next gate: x",
                           "created": "2026-11-17T11:00:00.000+0000"}]}
        changes = {KEY: [{"created": "2026-11-17T12:00:00.000+0000", "author": {"accountId": t.OTHER},
                          "items": [{"field": "description"}]}]}
        self.seed([t.issue()], comments=comments, changelogs=changes)
        self.assertEqual(self.gate("triageable", ticket_key=KEY)[0], "pass")

    def test_an_unreadable_ticket_stops_the_gate_it_is_not_a_refusal(self):
        with self.assertRaises(GateError):
            self.gate("triageable", ticket_key="JP-404")


class TheReadGates(GateCase):
    def test_they_never_write(self):
        self.gate("ticket-facts", ticket_key=KEY)
        self.gate("ready-check", ticket_key=KEY, ticket_type="Story", version=self.version())
        self.gate("route", ticket_key=KEY, ticket_type="Story")
        self.assertEqual(self.writes(), [])

    def test_facts(self):
        outcome, outputs, _ = self.gate("ticket-facts", ticket_key=KEY)
        self.assertEqual((outcome, outputs["ticket_type"], outputs["author_kind"]), ("read", "Story", "own"))
        self.assertEqual(outputs["version"], self.version())

    def test_route_and_its_outputs_hold_no_priority(self):
        outcome, outputs, _ = self.gate("route", ticket_key=KEY, ticket_type="Story")
        self.assertEqual((outcome, outputs["graph"], outputs["system"], outputs["space"]), ("development", "development", "josh-360", "JP"))
        self.assertNotIn("priority", json.dumps(outputs).lower())

    def test_a_work_kind_code_ticket_with_repository_none_is_a_conflict(self):
        self.seed([t.issue(type_="Task", desc=t.description(type="Task", repository="none"))],
                  {"JP-9001|action-triage.spec": {"type": "code"}})
        outcome, outputs, _ = self.gate("route", ticket_key=KEY, ticket_type="Task")
        self.assertEqual(outcome, "conflict")
        self.assertIn("code", outputs["route_reason"])

    def test_a_ticket_that_cannot_be_read_stops_the_gate(self):
        with self.assertRaises(GateError):
            self.gate("ready-check", ticket_key="JP-404", ticket_type="Story", version="x")


class TheSignOffCheck(GateCase):
    def check(self, defects, authors=(), version=None):
        return self.gate("check-sign-off", ticket_key=KEY, defects=list(defects), authors=list(authors),
                         version=version or self.version())

    def test_no_defects_is_ready(self):
        self.assertEqual(self.check([])[0], "ready")

    def test_an_author_cannot_sign(self):
        self.assertEqual(self.check([], authors=["s-signer"])[0], "invalid")

    def test_an_author_on_the_ticket_cannot_sign_either(self):
        self.seed([t.issue()], {"JP-9001|josh360.authors": ["s-signer"]})
        self.assertEqual(self.check([])[0], "invalid")

    def test_no_signing_session_on_record_is_invalid_never_ok(self):
        self.signer = None
        self.assertEqual(self.check([])[0], "invalid")

    def test_a_ticket_changed_while_judged_is_invalid(self):
        self.assertEqual(self.check([], version="an-older-version")[0], "invalid")

    def test_a_defect_that_quotes_the_ticket_is_kept_and_one_that_does_not_is_dropped_and_saved(self):
        good = {"item": "J1", "quote": "Read STEPS in laptop/install.py.", "problem": "p", "needed": "n"}
        bad = dict(good, quote="never written")
        outcome, outputs, _ = self.check([good, bad])
        self.assertEqual((outcome, len(outputs["kept"])), ("gaps", 1))
        saved = json.loads((self.tmp / "runs" / RUN / "outputs" / "dropped-defects.json").read_text())
        self.assertEqual(saved[0]["reason"], "quote not in ticket")


class TheWriteGates(GateCase):
    def test_send_back_only_comments_and_says_it_once(self):
        self.seed([t.issue(creator=t.OTHER)])
        gaps = [{"n": 1, "item": "C6", "where": "Acceptance criteria", "found": "no tag", "needed": "a tag"}]
        self.assertEqual(self.gate("send-back", ticket_key=KEY, gaps=gaps)[0], "sent")
        self.gate("send-back", ticket_key=KEY, gaps=gaps)               # a run repeated after a crash
        self.assertEqual([w["path"] for w in self.writes()], ["/rest/api/3/issue/JP-9001/comment"])

    def test_send_back_screens_for_patient_data(self):
        self.seed([t.issue(creator=t.OTHER)])
        gaps = [{"n": 1, "item": "C3", "where": "Why", "found": "member 000-00-0000", "needed": "remove it"}]
        with self.assertRaises(GateError):
            self.gate("send-back", ticket_key=KEY, gaps=gaps)
        self.assertEqual(self.writes(), [])

    def test_post_question_posts_the_spec_copy_once(self):
        ask = {"needs_josh": {"question": "Which file holds the first step", "recommendation": "laptop/install.py",
                              "reason": "it holds STEPS"}, "action": "revise"}
        self.gate("post-question", ticket_key=KEY, proposal=ask)
        self.gate("post-question", ticket_key=KEY, proposal=ask)
        bodies = [c["body"] for c in self.state()["comments"][KEY]]
        self.assertEqual(len(bodies), 1)
        self.assertIn("Triage: one question for Josh | run " + RUN, json.dumps(bodies))

    def revision(self, **over):
        body = {"action": "revise", "closes": [1], "authors": ["s-drafter"], "tickets": [
            {"key": KEY, "type": "Story", "repository": "josh-360", "where_it_runs": "Cloud session",
             "sections": h.section_set(goal="A better goal for the same work.")}]}
        body.update(over)
        return body

    def test_apply_revision_writes_the_description_the_authors_and_a_round_note(self):
        outcome, _, _ = self.gate("apply-revision", ticket_key=KEY, proposal=self.revision(), version=self.version())
        self.assertEqual(outcome, "applied")
        state = self.state()
        self.assertIn("A better goal", json.dumps(state["issues"][KEY]["fields"]["description"]))
        self.assertEqual(state["properties"]["JP-9001|josh360.authors"], ["s-drafter"])
        self.assertIn("round 1 of 2 | run " + RUN, json.dumps(state["comments"][KEY]))
        self.assertIn("Changed sections: Goal.", json.dumps(state["comments"][KEY]))

    def test_apply_revision_does_not_write_a_ticket_that_changed_since_the_drafter_read_it(self):
        outcome, _, _ = self.gate("apply-revision", ticket_key=KEY, proposal=self.revision(), version="stale")
        self.assertEqual(outcome, "changed")
        self.assertEqual(self.writes(), [])

    def test_apply_revision_never_edits_someone_elses_ticket(self):
        self.seed([t.issue(creator=t.OTHER)])
        with self.assertRaisesRegex(GateError, "not an own ticket"):
            self.gate("apply-revision", ticket_key=KEY, proposal=self.revision(), version=self.version())
        self.assertEqual(self.writes(), [])

    def test_apply_revision_refuses_a_revision_for_another_ticket_or_a_new_type(self):
        other = self.revision()
        other["tickets"][0]["key"] = "JP-9002"
        with self.assertRaisesRegex(GateError, "not JP-9001"):
            self.gate("apply-revision", ticket_key=KEY, proposal=other, version=self.version())
        other = self.revision()
        other["tickets"][0]["type"] = "Bug"
        with self.assertRaisesRegex(GateError, "not a revision"):
            self.gate("apply-revision", ticket_key=KEY, proposal=other, version=self.version())
        self.assertEqual(self.writes(), [])

    def mark(self, version=None, **over):
        args = dict(ticket_key=KEY, version=version or self.version(), graph="development", system="josh-360", space="JP")
        args.update(over)
        return self.gate("mark-ready", **args)

    def test_mark_ready_writes_the_record_then_moves_then_comments(self):
        self.assertEqual(self.mark()[0], "moved")
        paths = [(w["method"], w["path"].rsplit("/", 1)[-1]) for w in self.writes()]
        self.assertEqual(paths, [("PUT", "josh360.route"), ("POST", "transitions"), ("POST", "comment")])
        self.assertNotIn("priority", json.dumps(self.state()["properties"]).lower())

    def test_mark_ready_moves_nothing_when_the_ticket_changed_after_sign_off(self):
        self.assertEqual(self.mark(version="v1")[0], "changed")
        self.assertEqual(self.writes(), [])
        self.assertEqual(self.state()["issues"][KEY]["fields"]["status"], {"name": "Not Started"})

    def test_mark_ready_needs_a_provable_signing_session(self):
        self.signer = None
        with self.assertRaisesRegex(GateError, "no signing session"):
            self.mark()
        self.assertEqual(self.writes(), [])

    def test_mark_ready_refuses_a_ticket_that_is_not_in_not_started(self):
        self.seed([t.issue(status="In Progress")])
        with self.assertRaises(GateError):
            self.mark()

    def test_mark_ready_counts_returns_and_points_at_the_newest_note(self):
        notes = [{"id": "c1", "body": "Returned to triage | from run r-1", "created": "2026-11-17T10:00:00.000+0000"}]
        self.seed([t.issue()], comments={KEY: notes})
        self.mark()
        record = self.state()["properties"]["JP-9001|josh360.route"]
        self.assertEqual((record["returns"], record["returns_seen"], record["returned_from"]), (1, 1, "c1"))

    def test_a_move_jira_does_not_confirm_is_a_failure(self):
        module = h.load_gate("mark-ready")
        deps = Deps()
        deps.signing_session = lambda run_id: "s-signer"
        deps.jira.transition = lambda key, status: False
        with self.assertRaisesRegex(GateError, "not confirmed in Ready"):
            module.run({"ticket_key": KEY, "version": self.version(), "graph": "development", "system": "josh-360",
                        "space": "JP"}, deps)
        self.assertEqual([w["path"].rsplit("/", 1)[-1] for w in self.writes()], ["josh360.route"])


class TheTargetGraphsEntryGate(GateCase):
    def ready(self, **over):
        record = {"graph": "development", "system": "josh-360", "space": "JP", "version": self.version(),
                  "run": RUN, "signed_by": "s-1", "returns": 0, "returns_seen": 0, "returned_from": ""}
        record.update(over)
        self.seed([t.issue(status="Ready")], {"JP-9001|josh360.route": record})
        record["version"] = over.get("version") or self.version()
        self.seed([t.issue(status="Ready")], {"JP-9001|josh360.route": record})

    def enter(self, graph="development"):
        os.environ["JOSH360_GRAPH"] = graph
        return self.gate("ready", ticket_key=KEY)

    def test_a_ready_ticket_routed_here_passes(self):
        self.ready()
        self.assertEqual(self.enter()[0], "pass")

    def test_a_ticket_routed_to_the_other_graph_is_refused(self):
        self.ready()
        self.assertEqual(self.enter("non-development")[0], "refuse")

    def test_a_ticket_edited_after_sign_off_is_refused(self):
        self.ready(version="the-signed-version")
        self.assertIn("edited after sign-off", self.enter()[2])

    def test_a_ticket_not_in_ready_or_with_no_route_record_is_refused(self):
        self.assertEqual(self.enter()[0], "refuse")
        self.seed([t.issue(status="Ready")])
        self.assertIn("no route record", self.enter()[2])

    def test_it_needs_to_know_which_graph_it_guards(self):
        with self.assertRaises(GateError):
            self.gate("ready", ticket_key=KEY)


class EveryGateScriptRunsAsTheWalkerRunsIt(GateCase):
    def test_the_real_script_prints_one_json_line_and_exits_zero(self):
        code, line, err = h.run_gate("ticket-facts", self.tmp, {"ticket_key": KEY},
                                     {"JOSH360_JIRA_FAKE": str(self.fake), "JOSH360_RUN_ID": RUN})
        self.assertEqual((code, line["outcome"]), (0, "read"), err)

    def test_a_gate_that_cannot_finish_exits_non_zero_and_prints_no_outcome(self):
        code, line, err = h.run_gate("ticket-facts", self.tmp, {"ticket_key": "JP-404"},
                                     {"JOSH360_JIRA_FAKE": str(self.fake), "JOSH360_RUN_ID": RUN})
        self.assertNotEqual(code, 0)
        self.assertIsNone(line)


if __name__ == "__main__":
    unittest.main()
