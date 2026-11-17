"""Tests for link-source and intake-closed, the last two gates of ticket creation (JP-121). Everything is made up."""
from __future__ import annotations

import json
import sqlite3
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import ticket_creation_helpers as h
from test_gate_create_tickets import WritingFake
from test_gate_jira import client

intake_closed = h.load_gate("intake-closed")


def desk(tmp, conversation_id="c-1", jira_key=None):
    conn = sqlite3.connect(str(Path(tmp) / "desk.db"))
    conn.execute("CREATE TABLE threads (conversation_id TEXT PRIMARY KEY, row_id TEXT, jira_key TEXT)")
    conn.execute("INSERT INTO threads VALUES (?, ?, ?)", (conversation_id, "row-1", jira_key))
    conn.commit()
    conn.close()


def desk_key(tmp):
    conn = sqlite3.connect(str(Path(tmp) / "desk.db"))
    try:
        return conn.execute("SELECT jira_key FROM threads").fetchone()[0]
    finally:
        conn.close()


def read_items(tmp):
    return json.loads((Path(tmp) / "action-items.json").read_text())


class LinkingTheSource(unittest.TestCase):
    def test_a_todo_gets_the_key_and_becomes_tasked(self):
        with TemporaryDirectory() as tmp:
            h.action_items(tmp, h.todo())
            code, out, _ = h.run_gate("link-source", tmp, {"source": "todo", "source_ref": "todo-0007",
                                                           "ticket_keys": ["JP-201", "JP-202"], "match_key": "none"})
            self.assertEqual((code, out["outcome"]), (0, "linked"))
            item = read_items(tmp)["todos"][0]
            self.assertEqual((item["ticketKey"], item["status"]), ("JP-201", "tasked"))
            self.assertFalse((Path(tmp) / "action-items.json.lock").exists())

    def test_linking_twice_changes_nothing_more(self):
        with TemporaryDirectory() as tmp:
            h.action_items(tmp, h.todo())
            args = {"source": "todo", "source_ref": "todo-0007", "ticket_keys": ["JP-201"], "match_key": "none"}
            h.run_gate("link-source", tmp, args)
            first = read_items(tmp)
            code, _, _ = h.run_gate("link-source", tmp, args)
            self.assertEqual((code, read_items(tmp)), (0, first))

    def test_a_held_lock_stops_the_run_and_leaves_the_file_alone(self):
        with TemporaryDirectory() as tmp:
            h.action_items(tmp, h.todo())
            before = read_items(tmp)
            (Path(tmp) / "action-items.json.lock").write_text("{}")
            code, out, err = h.run_gate("link-source", tmp, {"source": "todo", "source_ref": "todo-0007",
                                                             "ticket_keys": ["JP-201"], "match_key": "none"})
            self.assertEqual(code, 1)
            self.assertEqual(read_items(tmp), before)
            self.assertTrue((Path(tmp) / "action-items.json.lock").exists())  # someone else's lock stays

    def test_an_item_that_is_not_there_stops_the_run(self):
        with TemporaryDirectory() as tmp:
            h.action_items(tmp, h.todo())
            code, _, _ = h.run_gate("link-source", tmp, {"source": "todo", "source_ref": "todo-9999",
                                                         "ticket_keys": ["JP-201"], "match_key": "none"})
            self.assertEqual(code, 1)

    def test_a_desk_email_thread_gets_the_key(self):
        with TemporaryDirectory() as tmp:
            desk(tmp)
            code, out, _ = h.run_gate("link-source", tmp, {"source": "email", "source_ref": "c-1",
                                                           "ticket_keys": ["AD-501"], "match_key": "none"})
            self.assertEqual((code, desk_key(tmp)), (0, "AD-501"))

    def test_after_a_comment_the_match_key_is_linked(self):
        with TemporaryDirectory() as tmp:
            desk(tmp)
            code, _, _ = h.run_gate("link-source", tmp, {"source": "email", "source_ref": "c-1",
                                                         "ticket_keys": [], "match_key": "AD-412"})
            self.assertEqual((code, desk_key(tmp)), (0, "AD-412"))

    def test_no_key_at_all_stops_the_run(self):
        with TemporaryDirectory() as tmp:
            h.action_items(tmp, h.todo())
            code, _, _ = h.run_gate("link-source", tmp, {"source": "todo", "source_ref": "todo-0007",
                                                         "ticket_keys": [], "match_key": "none"})
            self.assertEqual(code, 1)

    def test_a_session_source_needs_no_store(self):
        with TemporaryDirectory() as tmp:
            code, out, _ = h.run_gate("link-source", tmp, {"source": "session", "source_ref": "sess-1",
                                                           "ticket_keys": ["JP-201"], "match_key": "none"})
            self.assertEqual((code, out["outcome"]), (0, "linked"))


class ClosingTheIntake(unittest.TestCase):
    def values(self, **over):
        base = {"proposal": h.proposal(), "source": "todo", "source_ref": "todo-0007", "ticket_keys": ["JP-201"]}
        base.update(over)
        return base

    def made(self):
        fake = WritingFake()
        fake.issues["JP-201"] = {"key": "JP-201", "fields": {"summary": "x", "parent": {"key": "JP-94"}, "labels": [],
                                                              "issuelinks": [], "status": {"name": "Not Started"}}}
        return client(fake)

    def with_todo(self, tmp, **over):
        import os
        h.action_items(tmp, h.todo(**over))
        os.environ["JOSH360_ACTION_ITEMS"] = str(Path(tmp) / "action-items.json")
        os.environ["JOSH360_RUNS"] = str(Path(tmp) / "runs")
        self.addCleanup(lambda: [os.environ.pop(k, None) for k in ("JOSH360_ACTION_ITEMS", "JOSH360_RUNS")])

    def test_passes_when_the_ticket_reads_back_and_the_item_carries_the_key(self):
        with TemporaryDirectory() as tmp:
            self.with_todo(tmp, ticketKey="JP-201", status="tasked")
            outcome, summary = intake_closed.decide(self.values(), self.made())
            self.assertEqual(outcome, "pass", summary)

    def test_open_when_the_item_does_not_carry_the_key(self):
        with TemporaryDirectory() as tmp:
            self.with_todo(tmp)
            self.assertEqual(intake_closed.decide(self.values(), self.made())[0], "open")

    def test_open_when_jira_cannot_read_the_ticket_back(self):
        with TemporaryDirectory() as tmp:
            self.with_todo(tmp, ticketKey="JP-201", status="tasked")
            fake = WritingFake()
            self.assertEqual(intake_closed.decide(self.values(), client(fake))[0], "open")

    def test_open_when_fewer_tickets_exist_than_were_proposed(self):
        with TemporaryDirectory() as tmp:
            self.with_todo(tmp, ticketKey="JP-201", status="tasked")
            values = self.values(proposal=h.family(), ticket_keys=["JP-201"])
            self.assertEqual(intake_closed.decide(values, self.made())[0], "open")

    def test_open_when_the_source_store_cannot_be_read(self):
        with TemporaryDirectory() as tmp:
            import os
            os.environ["JOSH360_ACTION_ITEMS"] = str(Path(tmp) / "missing.json")
            os.environ["JOSH360_RUNS"] = str(Path(tmp) / "runs")
            self.addCleanup(lambda: [os.environ.pop(k, None) for k in ("JOSH360_ACTION_ITEMS", "JOSH360_RUNS")])
            self.assertEqual(intake_closed.decide(self.values(), self.made())[0], "open")

    def test_a_comment_on_a_match_passes_when_the_item_carries_the_match_key(self):
        proposal = {"action": "comment_on_match", "gaps": [], "authors": [],
                    "match": {"key": "AD-412", "status": "In Progress", "request": "The export drops rows."}}
        with TemporaryDirectory() as tmp:
            self.with_todo(tmp, ticketKey="AD-412", status="tasked")
            values = self.values(proposal=proposal, ticket_keys=[])
            self.assertEqual(intake_closed.decide(values, self.made())[0], "pass")
            self.with_todo(tmp, ticketKey="AD-999", status="tasked")
            self.assertEqual(intake_closed.decide(values, self.made())[0], "open")

    def test_a_ticket_with_no_parent_and_no_area_is_open(self):
        with TemporaryDirectory() as tmp:
            self.with_todo(tmp, ticketKey="JP-201", status="tasked")
            fake = WritingFake()
            fake.issues["JP-201"] = {"key": "JP-201", "fields": {"summary": "x", "parent": None, "labels": [],
                                                                  "issuelinks": [], "status": {"name": "Not Started"}}}
            proposal = h.proposal(route={"space": "JP", "parent": None, "area": None, "system": "x", "priority": "p",
                                         "labels": [], "rule": "r"})
            outcome, _ = intake_closed.decide(self.values(proposal=proposal), client(fake))
            self.assertEqual(outcome, "open")


if __name__ == "__main__":
    unittest.main()
