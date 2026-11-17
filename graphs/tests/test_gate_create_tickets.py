"""Tests for create-tickets: writing an approved proposal to Jira (JP-121). A fake Jira records every call.

Run: python3 -m unittest discover -s graphs/tests   (from the repository root)
"""
from __future__ import annotations

import json
import unittest

import ticket_creation_helpers as h
from test_gate_jira import FakeJira, client

create_tickets = h.load_gate("create-tickets")


class WritingFake(FakeJira):
    """FakeJira whose search finds what it has created, so a second look sees the first create."""

    def default(self, method, path, data):
        bare = path.split("?")[0]
        if method == "POST" and bare == "/rest/api/3/search/jql":
            rows = [{"key": k, "fields": v["fields"]} for k, v in self.issues.items()]
            return 200, json.dumps({"issues": rows, "isLast": True}).encode(), {}
        if method == "POST" and bare == "/rest/api/3/issue":
            parent = (data["fields"].get("parent") or {}).get("key")
            status, body, headers = super().default(method, path, data)
            key = json.loads(body)["key"]
            self.issues[key]["fields"]["parent"] = {"key": parent} if parent else None
            self.issues[key]["fields"]["labels"] = data["fields"].get("labels", [])
            return status, body, headers
        return super().default(method, path, data)

    def creates(self):
        return [c for c in self.calls if c[0] == "POST" and c[1] == "/rest/api/3/issue"]


def run(fake, proposal, match_key="none", source="todo", source_ref="todo-0007"):
    return create_tickets.run(client(fake), proposal, source, source_ref, match_key, today="2026-11-17")


class WritingASingleTicket(unittest.TestCase):
    def test_one_ticket_is_created_and_read_back(self):
        fake = WritingFake()
        outcome, out = run(fake, h.proposal())
        self.assertEqual((outcome, out["ticket_keys"], out["missing"]), ("created", ["JP-201"], []))
        body = fake.creates()[0][2]
        self.assertEqual(body["fields"]["parent"], {"key": "JP-94"})
        self.assertEqual(body["fields"]["labels"], ["josh-360"])
        self.assertEqual(body["fields"]["issuetype"], {"name": "Story"})
        self.assertEqual(fake.calls[-1][0], "GET")  # the last thing it did was read the ticket back

    def test_properties_are_written(self):
        fake = WritingFake()
        run(fake, h.proposal())
        self.assertEqual(fake.properties[("JP-201", "action-triage.spec")], {"type": "code"})
        self.assertEqual(fake.properties[("JP-201", "josh360.authors")], ["session-a", "session-b"])

    def test_it_never_sets_a_forbidden_field(self):
        fake = WritingFake()
        run(fake, h.family())
        for _, _, body in fake.creates():
            for name in ("priority", "assignee", "duedate", "customfield_10452", "customfield_10453", "timetracking",
                         "story_points", "customfield_10016"):
                self.assertNotIn(name, body["fields"])

    def test_the_description_is_josh_format_with_a_gherkin_block(self):
        fake = WritingFake()
        run(fake, h.proposal())
        description = fake.creates()[0][2]["fields"]["description"]
        kinds = [n["type"] for n in description["content"]]
        self.assertIn("codeBlock", kinds)
        self.assertIn("bulletList", kinds)

    def test_an_unconfirmed_create_is_found_by_search_and_never_made_twice(self):
        fake = WritingFake()
        real_default = fake.default

        def timed_out(method, path, data):
            result = real_default(method, path, data)
            if method == "POST" and path.split("?")[0] == "/rest/api/3/issue":
                raise TimeoutError("the answer never came")  # the ticket was made; the answer was lost
            return result

        fake.queue("POST", "/rest/api/3/issue", TimeoutError("lost"))
        # The first create is lost AFTER it is stored: model it by storing it, then raising.
        fake.default = lambda m, p, d: timed_out(m, p, d) if m == "POST" and p == "/rest/api/3/issue" and not \
            fake.issues else real_default(m, p, d)
        fake.script.clear()
        outcome, out = run(fake, h.proposal())
        self.assertEqual((outcome, out["ticket_keys"]), ("created", ["JP-201"]))
        self.assertEqual(len(fake.creates()), 1)

    def test_a_search_that_cannot_answer_creates_nothing(self):
        fake = WritingFake()
        fake.queue("POST", "/rest/api/3/search/jql", (500, b"{}", {}))
        outcome, out = run(fake, h.proposal())
        self.assertEqual((outcome, out["missing"]), ("partial", ["t1"]))
        self.assertEqual(fake.creates(), [])

    def test_a_ticket_that_exists_already_is_not_created_again(self):
        fake = WritingFake()
        run(fake, h.proposal())
        outcome, out = run(fake, h.proposal())
        self.assertEqual((outcome, out["ticket_keys"]), ("created", ["JP-201"]))
        self.assertEqual(len(fake.creates()), 1)


class WritingAParentWithChildren(unittest.TestCase):
    def test_parent_first_then_children_under_it(self):
        fake = WritingFake()
        outcome, out = run(fake, h.family())
        self.assertEqual((outcome, len(out["ticket_keys"])), ("created", 4))
        bodies = [c[2]["fields"] for c in fake.creates()]
        self.assertEqual(bodies[0]["issuetype"], {"name": "Epic"})
        self.assertNotIn("parent", bodies[0])
        self.assertTrue(all(b["parent"] == {"key": out["ticket_keys"][0]} for b in bodies[1:]))

    def test_blocks_links_follow_the_blocked_by_order(self):
        fake = WritingFake()
        _, out = run(fake, h.family())
        links = [c[2] for c in fake.calls if c[1].endswith("/issueLink") and c[0] == "POST"]
        epic, t2, t3, t4 = out["ticket_keys"]
        self.assertEqual([(l["type"]["name"], l["outwardIssue"]["key"], l["inwardIssue"]["key"]) for l in links],
                         [("Blocks", t2, t3), ("Blocks", t3, t4)])

    def test_one_child_failing_is_partial_and_the_retry_makes_only_that_one(self):
        fake = WritingFake()
        # The third create (child t3) is refused by a server error; the others succeed.
        count = {"n": 0}
        real_default = fake.default

        def flaky(method, path, data):
            if method == "POST" and path == "/rest/api/3/issue":
                count["n"] += 1
                if count["n"] == 3:
                    return 503, b"{}", {}
            return real_default(method, path, data)

        fake.default = flaky
        outcome, out = run(fake, h.family())
        # t3 was refused. t4 was made, but its "blocked by t3" link cannot be made until t3 exists.
        self.assertEqual((outcome, out["missing"]), ("partial", ["t3", "t4:link"]))
        fake.default = real_default
        before = len(fake.creates())
        outcome, out = run(fake, h.family())
        self.assertEqual(outcome, "created")
        self.assertEqual(len(fake.creates()) - before, 1)  # only t3 is made now; t4 already exists
        epic = out["ticket_keys"][0]
        for _, _, body in fake.creates()[before:]:
            self.assertEqual(body["fields"]["parent"], {"key": epic})
        links = [c[2] for c in fake.calls if c[1].endswith("/issueLink") and c[0] == "POST"]
        self.assertEqual(len(links), 2)  # t2 blocks t3 and t3 blocks t4, each exactly once

    def test_a_done_match_is_linked_with_relates(self):
        fake = WritingFake()
        proposal = h.proposal(match={"key": "JP-3", "status": "Done"})
        fake.issues["JP-3"] = {"key": "JP-3", "fields": {"summary": "Old", "issuelinks": []}}
        outcome, out = run(fake, proposal, match_key="JP-3")
        self.assertEqual(outcome, "created")
        link = [c[2] for c in fake.calls if c[1].endswith("/issueLink") and c[0] == "POST"][0]
        self.assertEqual((link["type"]["name"], link["outwardIssue"]["key"], link["inwardIssue"]["key"]),
                         ("Relates", out["ticket_keys"][0], "JP-3"))

    def test_a_read_back_that_does_not_match_is_partial(self):
        fake = WritingFake()
        real_default = fake.default

        def wrong_summary(method, path, data):
            status, body, headers = real_default(method, path, data)
            if method == "GET" and path.startswith("/rest/api/3/issue/JP-201?"):
                doc = json.loads(body)
                doc["fields"]["summary"] = "something else"
                body = json.dumps(doc).encode()
            return status, body, headers

        fake.default = wrong_summary
        outcome, out = run(fake, h.proposal())
        self.assertEqual((outcome, out["missing"]), ("partial", ["t1"]))


class CommentingOnAnOpenMatch(unittest.TestCase):
    PROPOSAL = {"action": "comment_on_match", "gaps": [], "authors": [],
                "match": {"key": "AD-412", "status": "In Progress", "request": "The export drops rows."}}

    def test_one_comment_with_the_designs_exact_text_and_no_ticket(self):
        fake = WritingFake()
        outcome, out = run(fake, self.PROPOSAL, match_key="AD-412", source="email", source_ref="c-1")
        self.assertEqual((outcome, out["ticket_keys"]), ("commented", []))
        self.assertEqual(fake.creates(), [])
        text = fake.comments_by_key["AD-412"][0]["body"]["content"][0]["content"][0]["text"]
        self.assertEqual(text, 'Another request for this came in from an email on 2026-11-17: "The export drops rows.". '
                               'Ticket creation found this ticket open, so it added this comment instead of a new '
                               'ticket. Source: c-1.')

    def test_a_repeat_after_an_unconfirmed_post_does_not_comment_twice(self):
        fake = WritingFake()
        run(fake, self.PROPOSAL, match_key="AD-412", source="email", source_ref="c-1")
        fake.comments_by_key["AD-412"][0]["author"] = {}  # the posted row is what comments() reads back
        outcome, _ = run(fake, self.PROPOSAL, match_key="AD-412", source="email", source_ref="c-1")
        self.assertEqual(outcome, "commented")
        self.assertEqual(len(fake.comments_by_key["AD-412"]), 1)

    def test_a_proposal_that_names_a_different_ticket_than_the_duplicate_check_is_refused(self):
        with self.assertRaises(ValueError):
            run(WritingFake(), self.PROPOSAL, match_key="AD-999", source="email", source_ref="c-1")


if __name__ == "__main__":
    unittest.main()
