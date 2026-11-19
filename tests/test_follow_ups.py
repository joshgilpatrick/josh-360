"""JP-175: a graph step reports work outside its ticket, a script files it through intake, and the sprint lead or the
epic lead is told by script. One test class per scenario of the ticket, plus the parts underneath.

Everything here is made up: a fake Jira folder, a fake agent-manager, a fake sprint.py and a temp sprint-state folder.
No test reaches Jira, Agent Manager or a model.
"""
import io
import json
import os
import sqlite3
import sys
import unittest
from pathlib import Path

from runner_helpers import ROOT, RunnerCase

sys.path.insert(0, str(ROOT / "graphs" / "tests"))
import ticket_creation_helpers as tch  # noqa: E402
from lib import follow_ups, sources  # noqa: E402
from lib.jira import Jira  # noqa: E402

create_tickets = tch.load_gate("create-tickets")
FAKE_SPRINT = ROOT / "tests" / "fakes" / "sprint.py"
WRAPPER = "import runpy\nrunpy.run_path({!r}, run_name='__main__')\n"


class FollowUpCase(RunnerCase):
    def setUp(self):
        super().setUp()
        for gate in ("file-follow-ups", "follow-up-wait"):
            (self.root / "gates" / (gate + ".py")).write_text(WRAPPER.format(str(ROOT / "graphs" / "gates" / (gate + ".py"))))
        self.sprints = self.tmp / "sprint-state"
        self.sprints.mkdir()
        os.environ.update({"SPRINT_STATE_ROOT": str(self.sprints), "JOSH360_SPRINT_PY": str(FAKE_SPRINT),
                           "JOSH360_SPRINT_PYTHON": sys.executable})
        self.am_db()
        self.jira_issue("JP-94", status="In Progress", issuetype="Epic", route=None)
        self.jira_issue("JP-95", status="In Progress", issuetype="Epic", route=None)
        for key, epic in (("JP-900", "JP-94"), ("JP-901", "JP-95"), ("JP-902", "JP-94")):
            self.jira_issue(key, status="In Progress", route=None)
            self.set_parent(key, epic)
        state = json.loads(self.jira_file().read_text())
        for issue in state["issues"].values():
            issue["fields"]["issuelinks"] = []
        self.jira_file().write_text(json.dumps(state))

    # -- made-up state -------------------------------------------------------------------------------------------
    def am_db(self):
        conn = sqlite3.connect(str(self.am_dir / "state.db"))
        conn.execute("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, name TEXT, status TEXT, archived INTEGER, "
                     "group_name TEXT, cwd TEXT, model TEXT, effort TEXT, agent_session_id TEXT)")
        conn.commit()
        conn.close()

    def am_session(self, sid, status="idle"):
        conn = sqlite3.connect(str(self.am_dir / "state.db"))
        conn.execute("INSERT OR REPLACE INTO sessions VALUES (?, ?, ?, 0, 'sprints/coordination', '/x', 'fable', "
                     "'high', NULL)", (sid, sid, status))
        conn.commit()
        conn.close()

    def sprint(self, slug, lead, live=True, tickets=None):
        folder = self.sprints / slug
        (folder / "tickets").mkdir(parents=True)
        (folder / "sprint.json").write_text(json.dumps({"slug": slug, "root_group": "sprints", "lead_session_id": lead}))
        for key, doc in (tickets or {}).items():
            (folder / "tickets" / (key + ".json")).write_text(json.dumps(dict({"key": key, "role": "worker"}, **doc)))
        self.am_session(lead, "idle" if live else "dead")

    def set_parent(self, key, parent):
        state = json.loads(self.jira_file().read_text())
        state["issues"][key]["fields"]["parent"] = {"key": parent}
        self.jira_file().write_text(json.dumps(state))

    def set_status(self, key, status):
        state = json.loads(self.jira_file().read_text())
        state["issues"][key]["fields"]["status"] = {"name": status}
        self.jira_file().write_text(json.dumps(state))

    def issue(self, key):
        return json.loads(self.jira_file().read_text())["issues"][key]

    def sent(self):
        path = self.am_dir / "sent.jsonl"
        return [json.loads(x) for x in path.read_text().splitlines()] if path.is_file() else []

    def handoffs(self):
        path = self.am_dir / "handoffs.jsonl"
        return [json.loads(x) for x in path.read_text().splitlines()] if path.is_file() else []

    # -- a run with a follow-up -----------------------------------------------------------------------------------
    def start(self, ticket):
        return self.walker("start", "--graph", "runner-sample", "--ticket", ticket, "--runner", "agent-manager")["run"]

    def runner_records(self, run, follow_ups_list):
        """The draft step's session writes its result with follow-ups and comes to rest; one runner pass records it."""
        doc = self.fake_spawn(run)
        path = Path(doc["result_file"])
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"outcome": "ready", "outputs": {"note": "a made-up note"},
                                    "follow_ups": follow_ups_list}))
        os.utime(str(path), (self.now, self.now))
        return self.advance(run)

    def intake_writes(self, ref):
        """What the ticket-creation run does once Josh approves its card: create-tickets, then link-source."""
        self.jira_state(apply_jql=False)            # the fake cannot judge create-tickets' `created >= -1d` search
        outcome, out = create_tickets.run(Jira.from_env(), tch.proposal(), "session", ref, "none", today="2026-11-19")
        self.assertEqual(outcome, "created", out)
        self.assertTrue(sources.link("session", ref, out["ticket_keys"]))
        self.jira_state(apply_jql=True)
        return out["ticket_keys"][0]

    def only_follow_up(self, run):
        items = follow_ups.load_all(run)
        self.assertEqual(len(items), 1, items)
        return follow_ups.ref(run, items[0]["id"]), items[0]

    def lead_messages(self, run):
        path = self.tmp / "runs" / run / "lead-messages.json"
        return json.loads(path.read_text())["messages"] if path.is_file() else []


class AFollowUpThatDoesNotBlock(FollowUpCase):
    """Scenario: A step reports a follow-up that does not block."""

    def test_it_is_filed_through_intake_the_lead_hears_and_the_run_moves_on(self):
        self.sprint("s1", "lead-1", tickets={"JP-900": {}})
        run = self.start("JP-900")
        state = self.runner_records(run, [{"summary": "Add a dry-run flag to the install script",
                                          "why": "JP-900 changes the runner, not the installer.", "blocks": False}])
        self.assertEqual(state, "parked")                         # the run moved on to its next step, Josh's go
        ref, item = self.only_follow_up(run)
        self.assertEqual(item["state"], "submitted")
        doc = json.loads((self.tmp / "runs" / item["intake_run"] / "run.json").read_text())
        self.assertEqual(doc["graph"], "ticket-creation")         # filed through intake, by pointer only
        self.assertEqual(doc["inputs"]["source"], "session")
        self.assertEqual(doc["inputs"]["source_ref"], ref)
        self.assertEqual(doc["inputs"]["named_parent"], "JP-94")
        self.assertNotIn("dry-run", json.dumps(doc["inputs"]))    # the step's words never travel as command text
        key = self.intake_writes(ref)
        self.assertIn(follow_ups.LABEL, self.issue(key)["fields"]["labels"])
        self.assertEqual(self.issue(key)["fields"]["issuelinks"], [])   # it does not block, so no Blocks link
        self.assertEqual(self.advance(run), "parked")
        handed = self.handoffs()
        self.assertEqual(len(handed), 1, handed)
        self.assertEqual(handed[0]["key"], key)
        self.assertIn("JP-900", handed[0]["note"])
        self.assertEqual(handed[0]["to"], "lead-1")
        self.advance(run)
        self.assertEqual(len(self.handoffs()), 1)                 # told once


class AFollowUpThatBlocks(FollowUpCase):
    """Scenario: A follow-up that blocks parks the run."""

    def test_the_new_ticket_blocks_the_origin_and_the_run_waits_on_it(self):
        from runner_lib import status
        from ledger import db
        run = self.start("JP-900")
        state = self.runner_records(run, [{"summary": "Fix the gate's Jira email", "why": "A gate bug, not this ticket.",
                                          "blocks": True}])
        self.assertEqual(state, "waiting")                        # held before its next step while it is drafted
        ref, _ = self.only_follow_up(run)
        key = self.intake_writes(ref)
        links = self.issue(key)["fields"]["issuelinks"]
        self.assertEqual(links, [{"type": {"name": "Blocks"}, "outwardIssue": {"key": "JP-900"}}])
        self.assertEqual(self.advance(run), "waiting")
        doc = self.walker("status", "--run", run)
        self.assertEqual(doc["waiting"]["on"], key)
        conn = db.connect(db.ledger_path())
        try:
            snap = status.snapshot(conn, self.now)
        finally:
            conn.close()
        row = [r for r in snap["open_runs"] if r["run"] == run][0]
        self.assertEqual((row["state"], row["waiting_on"]), ("waiting", key))
        self.assertIn("waiting on " + key, status.text(snap))
        self.set_status(key, "Done")
        self.assertEqual(self.advance(run), "parked")             # the blocker is out of the way: on to Josh's go
        self.assertEqual(follow_ups.load(ref)["state"], "resolved")

    def test_a_dropped_follow_up_lets_the_run_go_on_and_says_so(self):
        self.sprint("s1", "lead-1", tickets={"JP-900": {}})
        run = self.start("JP-900")
        self.assertEqual(self.runner_records(run, [{"summary": "A thing", "why": "Not this ticket.", "blocks": True}]),
                         "waiting")
        ref, item = self.only_follow_up(run)
        intake_doc = self.tmp / "runs" / item["intake_run"] / "run.json"
        doc = json.loads(intake_doc.read_text())
        doc["ended"] = "approve.drop"                             # Josh dropped it at the card
        intake_doc.write_text(json.dumps(doc))
        self.assertEqual(self.advance(run), "parked")
        self.assertEqual(follow_ups.load(ref)["state"], "dropped")
        self.assertTrue(any("was dropped" in m["text"] for m in self.sent()))


class TheEpicLeadIsTold(FollowUpCase):
    """Scenario: The epic lead is told when there is one."""

    def test_the_epic_lead_gets_the_message_and_the_sprint_lead_does_not(self):
        self.sprint("s1", "lead-1", tickets={"JP-95": {"role": "pm", "worker_session_id": "pm-95"}})
        self.am_session("pm-95", "working")
        run = self.end_sample_run("JP-901")
        self.assertEqual(self.advance(run), "done")
        sent = self.sent()
        self.assertEqual([m["to"] for m in sent], ["pm-95"])
        self.assertIn("JP-901", sent[0]["text"])
        self.assertIn("finished", sent[0]["text"])

    def test_with_no_running_epic_lead_the_sprint_lead_is_told(self):
        self.sprint("s1", "lead-1", tickets={"JP-95": {"role": "pm", "worker_session_id": "pm-95"}})
        self.am_session("pm-95", "dead")
        run = self.end_sample_run("JP-901")
        self.advance(run)
        self.assertEqual([m["to"] for m in self.sent()], ["lead-1"])


class NoLeadIsRunning(FollowUpCase):
    """Scenario: No lead is running."""

    def test_nothing_is_sent_and_the_message_is_kept_for_the_next_lead(self):
        from runner_lib import leads
        import runner
        self.sprint("s1", "lead-1", live=False)
        run = self.start("JP-902")
        self.plan({"lint-spec": ["crash"]})                       # a gate fails, so the run stops
        self.do_role(run, "draft", "ready", {"note": "a made-up note"})
        self.assertEqual(self.advance(run), "stopped")
        self.assertEqual(self.sent(), [])
        kept = self.lead_messages(run)
        self.assertEqual([(m["event"], m["sent"], m["kept"]) for m in kept], [("stopped", False, "no running lead")])
        out = io.StringIO()
        self.assertEqual(runner.main(["messages", "--json"], out), 0)
        self.assertEqual([r["run"] for r in json.loads(out.getvalue())], [run])
        self.assertEqual(leads.unsent()[0]["event"], "stopped")
        self.am_session("lead-1", "idle")                         # the next lead: the kept message goes on the next pass
        self.advance(run)
        self.assertEqual([m["to"] for m in self.sent()], ["lead-1"])
        self.assertTrue(self.lead_messages(run)[0]["sent"])
        self.assertEqual(len(self.sent()), 1)                     # and the stop is not told twice


class NoModelCallToTellALead(FollowUpCase):
    """Scenario: No model call is made to tell a lead."""

    def test_filing_and_finishing_send_messages_and_spawn_nothing(self):
        self.sprint("s1", "lead-1", tickets={"JP-900": {}})
        run = self.start("JP-900")
        step = self.walker("next", "--run", run)
        rf = Path(step["result_file"])
        rf.write_text(json.dumps({"outcome": "ready", "outputs": {"note": "n"}, "follow_ups": [
            {"summary": "A made-up gap", "why": "Not this ticket.", "blocks": False}]}))
        self.assertEqual(len(self.walker("record", "--run", run, "--step", "draft", "--result-file", rf)["follow_ups"]), 1)
        self.assertEqual(self.advance(run), "parked")
        ref, _ = self.only_follow_up(run)
        self.intake_writes(ref)
        self.answer_in_app(run, "confirm", "stop")
        self.assertEqual(self.advance(run), "done")
        self.assertEqual(len(self.handoffs()), 1)                 # the filed follow-up
        self.assertTrue(any("finished" in m["text"] for m in self.sent()))   # the end
        self.assertEqual(self.am_calls("spawn"), [])              # no Agent Manager session was spawned to send them


class TheResultShape(FollowUpCase):
    def record_with(self, follow_ups_list, code=0):
        run = self.walker("start", "--graph", "runner-sample", "--ticket", "JP-900", "--runner", "agent-manager",
                          "--allow-repeat")["run"]
        step = self.walker("next", "--run", run)
        rf = Path(step["result_file"])
        rf.write_text(json.dumps({"outcome": "ready", "outputs": {"note": "n"}, "follow_ups": follow_ups_list}))
        return run, self.walker("record", "--run", run, "--step", "draft", "--result-file", rf, code=code)

    def test_a_bad_follow_up_is_refused_like_an_undeclared_output(self):
        for bad, words in (({"summary": "x"}, "must be a list"), ([{"summary": "x", "blocks": False}], "why"), ([{"summary": "two\nlines", "why": "w", "blocks": False}], "one line"),
                           ([{"summary": "s", "why": "w", "blocks": "yes"}], "true or false"),
                           ([{"summary": "s", "why": "w", "blocks": False, "extra": 1}], "unknown field"),
                           ([{"summary": "s", "why": "w", "blocks": False}] * 6, "at most 5")):
            _, out = self.record_with(bad, code=2)
            self.assertIn(words, out["error"])

    def test_no_follow_ups_changes_nothing(self):
        run, out = self.record_with([])
        self.assertNotIn("follow_ups", out)
        self.assertEqual(follow_ups.load_all(run), [])

    def test_every_role_prompt_says_how_to_report_one(self):
        import binding
        self.fake_spawn(self.start("JP-900"))
        prompt = self.am_calls("spawn")[0][self.am_calls("spawn")[0].index("--prompt") + 1]
        self.assertIn(binding.FOLLOW_UPS, prompt)
        self.assertIn('"follow_ups"', prompt)


class AnOpenDuplicate(FollowUpCase):
    def test_a_comment_on_an_open_match_still_gets_the_blocks_link(self):
        run = self.start("JP-900")
        refs = follow_ups.save(run, "draft", 1, "JP-900", [{"summary": "s", "why": "w", "blocks": True}], "2026-11-19")
        self.jira_issue("JP-950", status="In Progress", route=None)
        state = json.loads(self.jira_file().read_text())
        state["issues"]["JP-950"]["fields"]["issuelinks"] = []
        self.jira_file().write_text(json.dumps(state))
        proposal = tch.proposal(action="comment_on_match", tickets=[],
                                match={"key": "JP-950", "status": "In Progress", "request": "Do the made-up thing."})
        outcome, out = create_tickets.run(Jira.from_env(), proposal, "session", refs[0], "JP-950", today="2026-11-19")
        self.assertEqual((outcome, out["missing"]), ("commented", []))
        self.assertEqual(self.issue("JP-950")["fields"]["issuelinks"],
                         [{"type": {"name": "Blocks"}, "outwardIssue": {"key": "JP-900"}}])

    def test_intake_sees_the_follow_up_file_as_the_item(self):
        run = self.start("JP-900")
        ref = follow_ups.save(run, "draft", 1, "JP-900", [{"summary": "s", "why": "w", "blocks": False}], "2026-11-19")[0]
        state = sources.item_state("session", ref)
        self.assertEqual((state["exists"], state["ticket_key"], state["dismissed"]), (True, None, False))
        self.assertEqual(sources.source_text("session", ref), "s\nw")
        self.assertTrue(sources.link("session", ref, ["JP-960"]))
        self.assertEqual(sources.item_state("session", ref)["ticket_key"], "JP-960")
        self.assertEqual(sources.item_state("session", "follow-up:../x:draft-1-1")["exists"], False)


if __name__ == "__main__":
    unittest.main()
