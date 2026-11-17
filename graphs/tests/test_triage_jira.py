"""JP-122: the Jira calls triage added to the shared client (exists, myself, changelog, read_property, set_description)
and the folder fake's changelog, with a scripted transport. Nothing here reaches a network; every text is made up.
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

GATES = Path(__file__).resolve().parent.parent / "gates"
sys.path.insert(0, str(GATES))

from lib import adf  # noqa: E402
from lib.jira import Jira, PatientDataRefused  # noqa: E402


def client(*answers):
    """A client whose transport returns `answers` in order: (status, body) pairs, an exception, or a callable."""
    queue = list(answers)
    seen = []

    def transport(method, url, headers, body):
        seen.append((method, url.split("atlassian.net", 1)[1], json.loads(body) if body else None))
        answer = queue.pop(0)
        if isinstance(answer, BaseException):
            raise answer
        status, payload = answer
        return status, json.dumps(payload).encode(), {}

    jira = Jira("https://example.atlassian.net", "a@example.com", "token", transport=transport, sleep=lambda s: None)
    return jira, seen


class Exists(unittest.TestCase):
    def test_yes_no_and_unknown(self):
        self.assertTrue(client((200, {"key": "JP-1"}))[0].exists("JP-1"))
        self.assertFalse(client((404, {}))[0].exists("JP-1"))
        self.assertIsNone(client((503, {}), (503, {}), (503, {}))[0].exists("JP-1"))
        self.assertIsNone(client(OSError())[0].exists("JP-1"))


class Myself(unittest.TestCase):
    def test_the_account_id_or_none(self):
        self.assertEqual(client((200, {"accountId": "acct-1"}))[0].myself(), "acct-1")
        self.assertIsNone(client((200, {}))[0].myself())
        self.assertIsNone(client((403, {}))[0].myself())


class Changelog(unittest.TestCase):
    ROW = {"created": "2026-11-17T10:00:00.000+0000", "author": {"accountId": "acct-1"},
           "items": [{"field": "Agent Status", "fieldId": "customfield_10453", "fromString": None, "toString": "Queued"}]}

    def test_one_page_is_read_in_order(self):
        jira, _ = client((200, {"values": [self.ROW], "total": 1, "isLast": True}))
        log = jira.changelog("JP-1")
        self.assertEqual((log[0]["author"], log[0]["items"][0]["to"]), ("acct-1", "Queued"))

    def test_a_second_page_is_followed(self):
        jira, seen = client((200, {"values": [self.ROW], "total": 2, "isLast": False}),
                            (200, {"values": [self.ROW], "total": 2, "isLast": True}))
        self.assertEqual(len(jira.changelog("JP-1")), 2)
        self.assertEqual(len(seen), 2)

    def test_a_page_that_fails_makes_the_whole_history_unknown(self):
        jira, _ = client((200, {"values": [self.ROW], "total": 2, "isLast": False}), (503, {}), (503, {}), (503, {}))
        self.assertIsNone(jira.changelog("JP-1"))


class ReadProperty(unittest.TestCase):
    def test_set_unset_unknown(self):
        self.assertEqual(client((200, {"key": "k", "value": {"a": 1}}))[0].read_property("JP-1", "k"), ("set", {"a": 1}))
        self.assertEqual(client((404, {}))[0].read_property("JP-1", "k"), ("unset", None))
        self.assertEqual(client((503, {}), (503, {}), (503, {}))[0].read_property("JP-1", "k"), ("unknown", None))


class SetDescription(unittest.TestCase):
    DOC = adf.doc(adf.labelled("Goal", "Something observable."))

    def issue(self, document):
        return (200, {"key": "JP-1", "fields": {"description": document, "summary": "s", "status": {"name": "Not Started"},
                                                 "issuetype": {"name": "Story"}, "labels": []}})

    def test_true_only_when_the_read_back_matches(self):
        jira, seen = client((204, {}), self.issue(self.DOC))
        self.assertTrue(jira.set_description("JP-1", self.DOC))
        self.assertEqual(seen[0][0:2], ("PUT", "/rest/api/3/issue/JP-1"))

    def test_false_when_the_read_back_differs(self):
        jira, _ = client((204, {}), self.issue(adf.doc(adf.labelled("Goal", "Something else."))))
        self.assertFalse(jira.set_description("JP-1", self.DOC))

    def test_false_when_jira_refuses(self):
        self.assertFalse(client((400, {}))[0].set_description("JP-1", self.DOC))

    def test_patient_data_is_refused_before_anything_is_sent(self):
        jira, seen = client()
        with self.assertRaises(PatientDataRefused):
            jira.set_description("JP-1", adf.doc(adf.paragraph("member 000-00-0000 called")))
        self.assertEqual(seen, [])


class MarkedText(unittest.TestCase):
    def test_a_gherkin_block_keeps_its_fence_and_bold_labels_keep_their_stars(self):
        doc = adf.doc(adf.labelled("Goal", "x"), adf.code_block("Feature: y"))
        marked = adf.to_marked(doc)
        self.assertIn("**Goal:** x", marked)
        self.assertIn("```gherkin\nFeature: y\n```", marked)


if __name__ == "__main__":
    unittest.main()
