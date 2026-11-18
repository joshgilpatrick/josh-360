"""Tests for the shared Jira library (graphs/gates/lib/jira.py, adf.py) and the two effect scripts (JP-121).

A fake transport stands in for Jira; nothing here reaches a network. Every text is made up.

Run: python3 -m unittest discover -s graphs/tests   (from the repository root)
"""
from __future__ import annotations

import io
import json
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from tempfile import TemporaryDirectory

GATES = Path(__file__).resolve().parent.parent / "gates"
sys.path.insert(0, str(GATES))

from lib import adf, jira  # noqa: E402
from lib.jira import Jira, JiraError, PatientDataRefused  # noqa: E402

TOKEN = "secret-token-1234"


class FakeJira:
    """A tiny in-memory Jira. Records every call; `script` queues answers for given (method, path) pairs first."""

    def __init__(self):
        self.calls = []
        self.script = {}
        self.issues = {}
        self.comments_by_key = {}
        self.properties = {}
        self.next_id = 1

    def queue(self, method, path_start, *answers):
        self.script.setdefault((method, path_start), []).extend(answers)

    def __call__(self, method, url, headers, body):
        assert headers["Authorization"].startswith("Basic ")
        path = url.split("atlassian.net", 1)[1]
        data = json.loads(body) if body else None
        self.calls.append((method, path, data))
        for (m, start), answers in self.script.items():
            if m == method and path.startswith(start) and answers:
                answer = answers.pop(0)
                if isinstance(answer, BaseException):
                    raise answer
                return answer
        return self.default(method, path, data)

    def default(self, method, path, data):
        bare = path.split("?")[0]
        parts = bare.strip("/").split("/")
        if method == "POST" and bare == "/rest/api/3/issue":
            key = f"JP-{200 + self.next_id}"
            self.next_id += 1
            self.issues[key] = {"key": key, "fields": dict(data["fields"], status={"name": "Not Started"},
                                                           issuelinks=[])}
            for prop in data.get("properties", []):
                self.properties[(key, prop["key"])] = prop["value"]
            return 201, json.dumps({"key": key}).encode(), {}
        if method == "POST" and bare == "/rest/api/3/search/jql":
            return 200, json.dumps({"issues": [], "isLast": True}).encode(), {}
        if method == "GET" and parts[:4] == ["rest", "api", "3", "issue"] and len(parts) == 5:
            issue = self.issues.get(parts[4])
            if issue is None:
                return 404, b"{}", {}
            return 200, json.dumps(issue).encode(), {}
        if method == "POST" and parts[-1] == "comment":
            cid = str(self.next_id)
            self.next_id += 1
            self.comments_by_key.setdefault(parts[4], []).append({"id": cid, "body": data["body"]})
            return 201, json.dumps({"id": cid}).encode(), {}
        if method == "GET" and len(parts) == 7 and parts[5] == "comment":
            for row in self.comments_by_key.get(parts[4], []):
                if row["id"] == parts[6]:
                    return 200, json.dumps(row).encode(), {}
            return 404, b"{}", {}
        if method == "GET" and parts[-1] == "comment":
            rows = [dict(r, author={"displayName": "Josh"}, created="2026-11-17T00:00:00.000+0000")
                    for r in self.comments_by_key.get(parts[4], [])]
            return 200, json.dumps({"comments": rows, "total": len(rows)}).encode(), {}
        if method == "PUT" and parts[5:6] == ["properties"]:
            self.properties[(parts[4], parts[6])] = data
            return 200, b"", {}
        if method == "GET" and parts[5:6] == ["properties"]:
            if (parts[4], parts[6]) in self.properties:
                return 200, json.dumps({"key": parts[6], "value": self.properties[(parts[4], parts[6])]}).encode(), {}
            return 404, b"{}", {}
        if method == "PUT" and len(parts) == 5:
            self.issues[parts[4]]["fields"].update(data["fields"])
            return 204, b"", {}
        if method == "GET" and parts[-1] == "transitions":
            return 200, json.dumps({"transitions": [{"id": "21", "to": {"name": "In Progress"}}]}).encode(), {}
        if method == "POST" and parts[-1] == "transitions":
            self.issues[parts[4]]["fields"]["status"] = {"name": "In Progress"}
            return 204, b"", {}
        if method == "GET" and bare == "/rest/api/3/issueLinkType":
            return 200, json.dumps({"issueLinkTypes": [
                {"name": "Blocks", "inward": "is blocked by", "outward": "blocks"},
                {"name": "Relates", "inward": "relates to", "outward": "relates to"}]}).encode(), {}
        if method == "POST" and bare == "/rest/api/3/issueLink":
            link = {"type": {"name": data["type"]["name"]}, "outwardIssue": data["inwardIssue"]}
            self.issues[data["outwardIssue"]["key"]]["fields"]["issuelinks"].append(link)
            return 201, b"", {}
        return 500, b"{}", {}


def client(fake, sleeps=None):
    return Jira("https://eventuswh-analytics.atlassian.net", "josh@example.com", TOKEN, transport=fake,
                sleep=(sleeps.append if sleeps is not None else lambda s: None))


class Creating(unittest.TestCase):
    def test_create_returns_the_key_on_201(self):
        fake = FakeJira()
        key = client(fake).create({"summary": "Add a flag", "project": {"key": "JP"}}, {"josh360.authors": ["s1"]})
        self.assertEqual(key, "JP-201")
        body = fake.calls[0][2]
        self.assertEqual(body["properties"], [{"key": "josh360.authors", "value": ["s1"]}])

    def test_create_returns_none_when_jira_does_not_answer(self):
        fake = FakeJira()
        fake.queue("POST", "/rest/api/3/issue", TimeoutError("slow"))
        self.assertIsNone(client(fake).create({"summary": "Add a flag"}))

    def test_create_returns_none_on_a_server_error_and_raises_on_a_refusal(self):
        fake = FakeJira()
        fake.queue("POST", "/rest/api/3/issue", (503, b"", {}), (400, b'{"errorMessages":["bad field"]}', {}))
        jira_client = client(fake)
        self.assertIsNone(jira_client.create({"summary": "x"}))
        with self.assertRaises(JiraError) as caught:
            jira_client.create({"summary": "x"})
        self.assertIn("bad field", str(caught.exception))

    def test_a_429_retries_with_retry_after_clamped_and_at_most_three_tries(self):
        fake = FakeJira()
        slow = (429, b"", {"Retry-After": "500"})
        fake.queue("POST", "/rest/api/3/search/jql", slow, slow, slow)
        sleeps = []
        self.assertIsNone(client(fake, sleeps).search("project = JP"))
        self.assertEqual(sleeps, [30.0, 30.0])
        self.assertEqual(len([c for c in fake.calls if c[1].endswith("search/jql")]), 3)

    def test_a_429_then_success(self):
        fake = FakeJira()
        fake.queue("POST", "/rest/api/3/search/jql", (429, b"", {"retry-after": "0"}))
        sleeps = []
        self.assertEqual(client(fake, sleeps).search("project = JP"), [])
        self.assertEqual(sleeps, [1.0])

    def test_the_token_is_never_in_an_error(self):
        fake = FakeJira()
        fake.queue("POST", "/rest/api/3/issue", (401, b'{"errorMessages":["no"]}', {}))
        with self.assertRaises(JiraError) as caught:
            client(fake).create({"summary": "x"})
        self.assertNotIn(TOKEN, str(caught.exception))

    def test_patient_data_in_a_summary_is_refused_before_any_request(self):
        fake = FakeJira()
        with self.assertRaises(PatientDataRefused) as caught:
            client(fake).create({"summary": "Fix chart for MRN 1234567"})
        self.assertEqual(caught.exception.kinds, ["labelled-id"])
        self.assertNotIn("1234567", str(caught.exception))
        self.assertEqual(fake.calls, [])


class Reading(unittest.TestCase):
    def test_get_gives_status_and_description_as_plain_text(self):
        fake = FakeJira()
        fake.issues["JP-9"] = {"key": "JP-9", "fields": {
            "summary": "A ticket", "status": {"name": "Ready", "statusCategory": {"key": "new"}},
            "description": adf.paragraphs("First line\nSecond line\n\nNext paragraph"), "labels": ["josh-360"]}}
        issue = client(fake).get("JP-9")
        self.assertEqual(issue["status"], "Ready")
        self.assertEqual(issue["description"], "First line\nSecond line\nNext paragraph")
        self.assertEqual(issue["labels"], ["josh-360"])

    def test_get_of_a_missing_ticket_is_none(self):
        self.assertIsNone(client(FakeJira()).get("JP-404"))

    def test_comments_come_back_as_plain_text_with_author_and_date(self):
        fake = FakeJira()
        jira_client = client(fake)
        jira_client.comment("JP-9", "Hello there")
        rows = jira_client.comments("JP-9")
        self.assertEqual([(r["author"], r["body"]) for r in rows], [("Josh", "Hello there")])
        self.assertTrue(rows[0]["created"])

    def test_get_property_is_none_when_unset(self):
        fake = FakeJira()
        jira_client = client(fake)
        self.assertIsNone(jira_client.get_property("JP-9", "action-triage.spec"))
        self.assertTrue(jira_client.set_property("JP-9", "action-triage.spec", {"type": "code"}))
        self.assertEqual(jira_client.get_property("JP-9", "action-triage.spec"), {"type": "code"})

    def test_create_meta_maps_type_names_to_ids(self):
        fake = FakeJira()
        fake.queue("GET", "/rest/api/3/issue/createmeta", (200, json.dumps(
            {"issueTypes": [{"id": "10001", "name": "Story"}, {"id": "10002", "name": "Task"}]}).encode(), {}))
        self.assertEqual(client(fake).create_meta("JP"), {"Story": "10001", "Task": "10002"})


class Writing(unittest.TestCase):
    def test_comment_reads_back(self):
        fake = FakeJira()
        self.assertTrue(client(fake).comment("JP-9", "A note"))
        self.assertEqual(fake.calls[-1][0], "GET")

    def test_comment_is_false_when_the_read_back_fails(self):
        fake = FakeJira()
        fake.queue("GET", "/rest/api/3/issue/JP-9/comment/", (404, b"{}", {}))
        self.assertFalse(client(fake).comment("JP-9", "A note"))

    def test_comment_with_a_patient_identifier_is_refused_and_not_sent(self):
        fake = FakeJira()
        with self.assertRaises(PatientDataRefused):
            client(fake).comment("JP-9", "Patient: Smith needs a call back")
        self.assertEqual(fake.calls, [])

    def test_transition_moves_and_confirms(self):
        fake = FakeJira()
        fake.issues["JP-9"] = {"key": "JP-9", "fields": {"status": {"name": "Ready"}}}
        self.assertTrue(client(fake).transition("JP-9", "in progress"))
        self.assertEqual(fake.issues["JP-9"]["fields"]["status"]["name"], "In Progress")

    def test_transition_is_false_when_no_transition_leads_there(self):
        fake = FakeJira()
        fake.issues["JP-9"] = {"key": "JP-9", "fields": {"status": {"name": "Ready"}}}
        self.assertFalse(client(fake).transition("JP-9", "Done"))

    def test_set_flag_confirms_on_and_off(self):
        fake = FakeJira()
        fake.issues["JP-9"] = {"key": "JP-9", "fields": {"status": {"name": "Ready"}}}
        jira_client = client(fake)
        self.assertTrue(jira_client.set_flag("JP-9", True))
        self.assertTrue(jira_client.get("JP-9")["flagged"])
        self.assertTrue(jira_client.set_flag("JP-9", False))
        self.assertFalse(jira_client.get("JP-9")["flagged"])

    def test_link_confirms_and_is_idempotent(self):
        fake = FakeJira()
        fake.issues["JP-1"] = {"key": "JP-1", "fields": {"issuelinks": []}}
        fake.issues["JP-2"] = {"key": "JP-2", "fields": {"issuelinks": []}}
        jira_client = client(fake)
        self.assertTrue(jira_client.link("Blocks", "JP-1", "JP-2"))
        posts = len([c for c in fake.calls if c[0] == "POST" and c[1].endswith("issueLink")])
        self.assertTrue(jira_client.link("Blocks", "JP-1", "JP-2"))
        self.assertEqual(posts, len([c for c in fake.calls if c[0] == "POST" and c[1].endswith("issueLink")]))

    def link_posts(self, fake):
        return [c for c in fake.calls if c[0] == "POST" and c[1].endswith("issueLink")]

    def test_a_link_the_other_way_round_is_not_taken_for_this_one(self):
        fake = FakeJira()
        # JP-2 already blocks JP-1: JP-1's own list shows JP-2 on the inward side.
        fake.issues["JP-1"] = {"key": "JP-1", "fields": {"issuelinks": [
            {"type": {"name": "Blocks"}, "inwardIssue": {"key": "JP-2"}}]}}
        fake.issues["JP-2"] = {"key": "JP-2", "fields": {"issuelinks": []}}
        self.assertTrue(client(fake).link("Blocks", "JP-1", "JP-2"))      # JP-1 blocks JP-2 is a different link
        self.assertEqual(len(self.link_posts(fake)), 1)
        outward = [x for x in fake.issues["JP-1"]["fields"]["issuelinks"] if "outwardIssue" in x]
        self.assertEqual([x["outwardIssue"]["key"] for x in outward], ["JP-2"])

    def test_a_relates_link_counts_from_either_end(self):
        fake = FakeJira()
        fake.issues["JP-1"] = {"key": "JP-1", "fields": {"issuelinks": [
            {"type": {"name": "Relates"}, "inwardIssue": {"key": "JP-2"}}]}}
        fake.issues["JP-2"] = {"key": "JP-2", "fields": {"issuelinks": []}}
        self.assertTrue(client(fake).link("Relates", "JP-1", "JP-2"))
        self.assertEqual(self.link_posts(fake), [])                        # it is already there

    def test_when_the_link_types_cannot_be_read_a_reverse_link_is_not_accepted(self):
        fake = FakeJira()
        fake.issues["JP-1"] = {"key": "JP-1", "fields": {"issuelinks": [
            {"type": {"name": "Relates"}, "inwardIssue": {"key": "JP-2"}}]}}
        fake.issues["JP-2"] = {"key": "JP-2", "fields": {"issuelinks": []}}
        fake.queue("GET", "/rest/api/3/issueLinkType", (500, b"{}", {}))
        self.assertTrue(client(fake).link("Relates", "JP-1", "JP-2"))
        self.assertEqual(len(self.link_posts(fake)), 1)                    # unknown is not symmetric: it posts

    def test_missing_credentials_fail_without_naming_a_value(self):
        err = io.StringIO()
        with redirect_stderr(err), self.assertRaises(SystemExit) as caught:
            Jira.from_env({})
        self.assertEqual(caught.exception.code, 1)
        self.assertIn("JOSH360_JIRA_TOKEN", err.getvalue())


class TheTwoEffectScripts(unittest.TestCase):
    def load(self, name):
        import importlib.util

        spec = importlib.util.spec_from_file_location(name.replace("-", "_"), GATES / f"{name}.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def run_script(self, name, argv, fake):
        module = self.load(name)
        out, err = io.StringIO(), io.StringIO()
        code = 0
        try:
            with redirect_stdout(out), redirect_stderr(err):
                module.main(argv, jira=client(fake))
        except SystemExit as exit_:
            code = exit_.code
        return code, out.getvalue(), err.getvalue()

    def test_set_flag_on_exits_0_when_confirmed(self):
        fake = FakeJira()
        fake.issues["JP-9"] = {"key": "JP-9", "fields": {}}
        code, out, _ = self.run_script("set-flag", ["--ticket", "JP-9", "--on"], fake)
        self.assertEqual((code, out.strip()), (0, "flag on JP-9"))

    def test_set_flag_exits_1_when_jira_does_not_confirm(self):
        fake = FakeJira()
        code, _, err = self.run_script("set-flag", ["--ticket", "JP-404", "--on"], fake)
        self.assertEqual(code, 1)
        self.assertIn("did not confirm", err)

    def test_post_comment_posts_the_file(self):
        fake = FakeJira()
        with TemporaryDirectory() as tmp:
            body = Path(tmp) / "answer.txt"
            body.write_text("Use the second option.", encoding="utf-8")
            code, out, _ = self.run_script("post-comment", ["--ticket", "JP-9", "--body-file", str(body)], fake)
        self.assertEqual((code, out.strip()), (0, "commented on JP-9"))
        self.assertEqual(adf.plain(fake.comments_by_key["JP-9"][0]["body"]), "Use the second option.")

    def test_post_comment_stops_at_a_patient_identifier(self):
        fake = FakeJira()
        with TemporaryDirectory() as tmp:
            body = Path(tmp) / "answer.txt"
            body.write_text("Call 555-867-5309 about the claim", encoding="utf-8")
            code, _, err = self.run_script("post-comment", ["--ticket", "JP-9", "--body-file", str(body)], fake)
        self.assertEqual(code, 1)
        self.assertIn("phone", err)
        self.assertNotIn("867", err)
        self.assertEqual(fake.calls, [])


class TheFakeSearch(unittest.TestCase):
    """The folder-backed fake judges a small JQL subset only when its state file says `apply_jql` (JP-117)."""

    SPRINT = "customfield_10020"

    def folder(self, tmp, **state):
        from lib import jira_fake
        path = Path(tmp)
        issues = {
            "JP-1": {"key": "JP-1", "fields": {"status": {"name": "Ready"}, "issuetype": {"name": "Story"},
                                                self.SPRINT: [{"state": "active"}]}},
            "JP-2": {"key": "JP-2", "fields": {"status": {"name": "Ready"}, "issuetype": {"name": "Story"},
                                                self.SPRINT: []}},
            "JP-3": {"key": "JP-3", "fields": {"status": {"name": "In Progress"}, "issuetype": {"name": "Bug"},
                                                self.SPRINT: [{"state": "active"}]}},
            "JP-4": {"key": "JP-4", "fields": {"status": {"name": "Ready"}, "issuetype": {"name": "Epic"},
                                                self.SPRINT: [{"state": "active"}]}},
        }
        (path / jira_fake.MARKER).write_text(json.dumps(dict(state, issues=issues)))
        return Jira("https://x.atlassian.net", "a@b.c", "t", transport=jira_fake.FileTransport(path))

    JQL = ("project = JP AND status = Ready AND sprint in openSprints() AND issuetype in (Story, Bug, Task) "
           "ORDER BY Rank ASC")

    def test_fake_search_applies_status_sprint_and_type(self):
        with TemporaryDirectory() as tmp:
            client = self.folder(tmp, apply_jql=True)
            self.assertEqual([i["key"] for i in client.search(self.JQL, ["status"])], ["JP-1"])
            self.assertEqual([i["key"] for i in client.search('status = "In Progress"')], ["JP-3"])

    def test_fake_search_refuses_a_clause_it_cannot_judge(self):
        with TemporaryDirectory() as tmp:
            client = self.folder(tmp, apply_jql=True)
            with self.assertRaises(JiraError) as caught:      # a 4xx raises in the shared client, as for Jira itself
                client.search("project = JP AND labels = josh-360")
            self.assertEqual(caught.exception.status, 400)

    def test_fake_search_without_the_flag_returns_everything(self):
        with TemporaryDirectory() as tmp:
            client = self.folder(tmp)
            self.assertEqual(len(client.search("labels = whatever")), 4)

    def test_fake_search_can_fail(self):
        with TemporaryDirectory() as tmp:
            client = self.folder(tmp, apply_jql=True, search_fails=True)
            self.assertIsNone(client.search(self.JQL))


class TheDocumentFormat(unittest.TestCase):
    def test_round_trip_plain_text(self):
        text = "One\nTwo\n\nThree"
        self.assertEqual(adf.plain(adf.paragraphs(text)), "One\nTwo\nThree")

    def test_to_text_handles_lists_and_code(self):
        document = adf.doc(
            {"type": "bulletList", "content": [
                {"type": "listItem", "content": [adf.paragraph("alpha")]},
                {"type": "listItem", "content": [adf.paragraph("beta")]}]},
            {"type": "codeBlock", "attrs": {"language": "gherkin"}, "content": [adf.text_node("Given a thing")]})
        self.assertEqual(adf.plain(document), "- alpha\n- beta\nGiven a thing")

    def test_none_is_empty_text(self):
        self.assertEqual(adf.plain(None), "")


if __name__ == "__main__":
    unittest.main()
