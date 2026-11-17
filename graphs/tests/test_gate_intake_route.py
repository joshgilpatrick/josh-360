"""Tests for the entry gate and the routing gate of ticket-creation (JP-121). Every record is made up.

Run: python3 -m unittest discover -s graphs/tests   (from the repository root)
"""
from __future__ import annotations

import sqlite3
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import ticket_creation_helpers as h


class TheEntryGate(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def admit(self, source="todo", ref="todo-0007"):
        return h.run_gate("intake-admitted", self.dir, {"source": source, "source_ref": ref})

    def test_admits_a_new_todo(self):
        h.action_items(self.dir, h.todo())
        code, out, _ = self.admit()
        self.assertEqual((code, out["outcome"]), (0, "pass"))

    def test_refuses_an_item_that_carries_a_ticket_key(self):
        h.action_items(self.dir, h.todo(taskId="ticket:JP-150"))
        _, out, _ = self.admit()
        self.assertEqual(out["outcome"], "refused")
        self.assertIn("JP-150", out["summary"])

    def test_refuses_a_dismissed_item(self):
        h.action_items(self.dir, h.todo(status="dismissed"))
        self.assertEqual(self.admit()[1]["outcome"], "refused")

    def test_refuses_an_item_that_does_not_exist(self):
        h.action_items(self.dir, h.todo("todo-other"))
        self.assertEqual(self.admit()[1]["outcome"], "refused")

    def test_refuses_an_unreadable_store_rather_than_admitting(self):
        (self.dir / "action-items.json").write_text("{not json", encoding="utf-8")
        _, out, _ = self.admit()
        self.assertEqual(out["outcome"], "refused")
        self.assertIn("cannot be read", out["summary"])

    def test_refuses_an_item_with_an_open_run_and_admits_it_once_that_run_ended(self):
        h.action_items(self.dir, h.todo())
        run = self.dir / "runs" / "r-abc123"
        run.mkdir(parents=True)
        h.write_json(run / "run.json", {"graph": "ticket-creation", "inputs": {"source": "todo",
                                                                               "source_ref": "todo-0007"}})
        self.assertEqual(self.admit()[1]["outcome"], "refused")
        h.write_json(run / "run.json", {"graph": "ticket-creation", "ended": "approve.drop",
                                        "inputs": {"source": "todo", "source_ref": "todo-0007"}})
        self.assertEqual(self.admit()[1]["outcome"], "pass")

    def test_the_run_being_started_does_not_block_itself(self):
        h.action_items(self.dir, h.todo())
        run = self.dir / "runs" / "r-me"
        run.mkdir(parents=True)
        h.write_json(run / "run.json", {"graph": "ticket-creation", "inputs": {"source": "todo",
                                                                               "source_ref": "todo-0007"}})
        code, out, _ = h.run_gate("intake-admitted", self.dir, {"source": "todo", "source_ref": "todo-0007"},
                                  {"JOSH360_RUN_ID": "r-me"})
        self.assertEqual(out["outcome"], "pass")

    def test_refuses_notion_in_the_first_wave(self):
        self.assertEqual(self.admit("notion", "n-1")[1]["outcome"], "refused")

    def test_refuses_a_pointer_that_is_text(self):
        self.assertEqual(self.admit("manual", "please add a flag to the script")[1]["outcome"], "refused")

    def test_admits_a_session_and_a_hand_typed_request_by_pointer(self):
        self.assertEqual(self.admit("session", "9b1f0c2e")[1]["outcome"], "pass")
        self.assertEqual(self.admit("manual", "manual-2026-11-17-01")[1]["outcome"], "pass")

    def test_email_thread_with_a_ticket_key_is_refused_and_a_new_one_admitted(self):
        db = sqlite3.connect(str(self.dir / "desk.db"))
        db.execute("CREATE TABLE threads (conversation_id TEXT PRIMARY KEY, row_id TEXT UNIQUE NOT NULL, jira_key TEXT, "
                   "worker_session_id TEXT, stage TEXT, project_dir TEXT, last_delivered_message_id TEXT, "
                   "created_at TEXT, updated_at TEXT)")
        db.execute("INSERT INTO threads (conversation_id, row_id, jira_key) VALUES ('c-1', 'r-1', NULL)")
        db.execute("INSERT INTO threads (conversation_id, row_id, jira_key) VALUES ('c-2', 'r-2', 'JP-77')")
        db.commit()
        db.close()
        self.assertEqual(self.admit("email", "c-1")[1]["outcome"], "pass")
        self.assertEqual(self.admit("email", "c-2")[1]["outcome"], "refused")


class Routing(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def route(self, record=None, **inputs):
        record = h.clone(record or h.RECORD)
        values = {"intake_record": h.write_json(self.dir / "record.json", record), "named_space": "none",
                  "named_parent": "none"}
        values.update(inputs)
        code, out, err = h.run_gate("route-ticket", self.dir, values)
        return code, out, err

    def test_a_named_space_wins(self):
        _, out, _ = self.route(named_space="AD")
        self.assertEqual(out["outputs"]["route"]["space"], "AD")
        self.assertEqual(out["outputs"]["route"]["rule"], "named")

    def test_the_repository_routes_josh_360(self):
        _, out, _ = self.route()
        route = out["outputs"]["route"]
        self.assertEqual(out["outcome"], "matched")
        self.assertEqual((route["space"], route["parent"], route["labels"], route["rule"]),
                         ("JP", "JP-94", ["josh-360"], "repository"))

    def test_a_named_parent_gives_its_space(self):
        _, out, _ = self.route(named_parent="AD-5")
        route = out["outputs"]["route"]
        self.assertEqual((out["outcome"], route["space"], route["parent"]), ("matched", "AD", "AD-5"))

    def test_repository_spelling_variants_still_match_the_registry(self):
        record = h.clone(h.RECORD)
        record["repository"] = {"value": "eventuswh-apps/josh_360.git", "basis": "stated"}
        _, out, _ = self.route(record)
        self.assertEqual(out["outputs"]["route"]["system"], "josh-360")

    def test_an_unknown_repository_is_unmatched_and_goes_to_jp(self):
        record = h.clone(h.RECORD)
        record["repository"] = {"value": "something-new", "basis": "inferred"}
        _, out, _ = self.route(record)
        route = out["outputs"]["route"]
        self.assertEqual(out["outcome"], "unmatched")
        self.assertEqual((route["space"], route["parent"], route["area"], route["labels"]), ("JP", None, None, []))

    def test_no_repository_and_no_folder_is_unmatched(self):
        record = h.clone(h.RECORD)
        record["repository"] = ""
        self.assertEqual(self.route(record)[1]["outcome"], "unmatched")

    def test_a_system_tracked_in_linear_is_personal(self):
        record = h.clone(h.RECORD)
        record["repository"] = {"value": "family_os", "basis": "stated"}
        self.assertEqual(self.route(record)[1]["outcome"], "personal")

    def test_the_folder_routes_when_there_is_no_repository(self):
        record = h.clone(h.RECORD)
        record["repository"] = ""
        record["folder"] = "~/Development/active/keystone-platform/src"
        _, out, _ = self.route(record)
        self.assertEqual((out["outcome"], out["outputs"]["route"]["space"], out["outputs"]["route"]["rule"]),
                         ("matched", "AD", "folder"))

    def test_tech_is_never_a_space(self):
        code, out, err = self.route(named_space="TECH")
        self.assertEqual(code, 1)
        self.assertIsNone(out)
        self.assertIn("TECH", err)


if __name__ == "__main__":
    unittest.main()
