"""JP-123, Task 1: the shared plumbing the non-development gates use. Made-up text only."""
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

from nondev_helpers import DESCRIPTION, Case

from lib import evidence, nondev_copy, ticket_port, ticket_text
from lib.gate_run import GateError, say, screened


class Sections(unittest.TestCase):
    def test_the_styles_a_description_can_arrive_in(self):
        for text in ("**Question:** What is x?\n**Sources:** a file\n",
                     "## Question\nWhat is x?\n## Sources\na file\n",
                     "Question:\nWhat is x?\n\nSources:\na file\n",
                     "- **Question**: What is x?\n- **Sources**: a file\n",
                     "Question\nWhat is x?\nSources\na file\n"):
            got = ticket_text.parse_sections(text)
            self.assertEqual((got["Question"], got["Sources"]), ("What is x?", "a file"), text)

    def test_a_section_runs_to_the_next_heading_across_lines_and_bullets(self):
        got = ticket_text.parse_sections(DESCRIPTION + "\n**Acceptance criteria:**\nGiven a\nWhen b\n")
        self.assertEqual(got["Why"], "Josh wants the trend.")
        self.assertEqual(got["Acceptance criteria"], "Given a\nWhen b")

    def test_a_sentence_that_starts_with_a_section_word_is_not_a_heading(self):
        got = ticket_text.parse_sections("**Question:** Why did the build fail?\nWhy is that asked? Because it broke.\n")
        self.assertEqual(list(got), ["Question"])

    def test_words_and_quotes(self):
        self.assertEqual(ticket_text.words("How many widgets? Widgets, again; ok."), ["many", "widgets", "again"])
        self.assertTrue(ticket_text.quotes("a  b\n c", "b c"))
        self.assertFalse(ticket_text.quotes("a b c", "B C"))
        self.assertFalse(ticket_text.quotes("a b c", ""))
        self.assertFalse(ticket_text.quotes("a b c", None))
        self.assertEqual(ticket_text.shorten("one two three four", 10), "one two…")
        self.assertTrue(ticket_text.is_inferred("a note (Inferred)"))

    def test_bool_and_list_inputs(self):
        self.assertTrue(ticket_text.as_bool(None))
        self.assertFalse(ticket_text.as_bool("false"))
        self.assertTrue(ticket_text.as_bool("maybe"))
        self.assertEqual(ticket_text.as_list('["a"]'), ["a"])
        self.assertEqual(ticket_text.as_list(""), [])
        with self.assertRaises(ValueError):
            ticket_text.as_list('{"a": 1}')


class Evidence(unittest.TestCase):
    def test_every_field_of_the_contract(self):
        doc = evidence.parse("---\nticket: JP-1\nphi: false\ndeliverables:\n  - /a/b.md\n  - /a/c.md\n"
                             "summary: 'It''s two counts: 40, 31.'\nsources:\n  - type: query\n    ref: JP-1-q.sql\n"
                             "    used_for: \"counts\"\n  - { type: ticket, ref: JP-0, used_for: earlier }\n"
                             "assumptions: []\nprecedent: none\nrecipient: a@b.co\nresolution: >\n  one\n  two\n---\nnotes\n")
        self.assertEqual(doc["ticket"], "JP-1")
        self.assertIs(doc["phi"], False)
        self.assertEqual(doc["deliverables"], ["/a/b.md", "/a/c.md"])
        self.assertEqual(doc["summary"], "It's two counts: 40, 31.")
        self.assertEqual([s["ref"] for s in evidence.sources(doc)], ["JP-1-q.sql", "JP-0"])
        self.assertEqual((doc["assumptions"], doc["precedent"], doc["recipient"]), ([], "none", "a@b.co"))
        self.assertEqual(doc["resolution"], "one two")

    def test_a_yaml_fence_works_and_a_missing_block_raises(self):
        self.assertEqual(evidence.parse("```yaml\nticket: JP-1\n```\n")["ticket"], "JP-1")
        for bad in ("no block", "---\nticket: JP-1\n", "---\nnot a pair\n---\n", "---\n  - orphan\n---\n"):
            with self.assertRaises(evidence.EvidenceError):
                evidence.parse(bad)

    def test_the_error_never_quotes_the_file(self):
        with self.assertRaises(evidence.EvidenceError) as caught:
            evidence.parse("---\nSSN 123-45-6789\n---\n")
        self.assertNotIn("123", str(caught.exception))

    def test_sources_without_a_ref_are_left_out(self):
        doc = evidence.parse("---\nsources:\n  - type: file\n---\n")
        self.assertEqual(evidence.sources(doc), [])

    def test_a_missing_file_raises_without_the_path_content(self):
        with self.assertRaises(evidence.EvidenceError):
            evidence.load(Path("/nonexistent/JP-1-evidence.md"))


class Copy(unittest.TestCase):
    def test_each_piece_matches_the_spec(self):
        self.assertEqual(nondev_copy.returned("why"), "Returned to triage | why | next gate: triage")
        self.assertEqual(nondev_copy.shared("a@b.co"), "Shared | a@b.co | next gate: close")
        self.assertEqual(nondev_copy.resolution("Q?", "A.", ["r1", "r2"], "/p/x.md", False),
                         "Resolution: Q? | A. | sources: r1, r2 | deliverable: /p/x.md | next gate: none")
        self.assertEqual(nondev_copy.resolution("Q?", "A.", [], "/p/x.md", True),
                         "Resolution: withheld: patient data | withheld: patient data | sources: none | "
                         "deliverable: /p/x.md | next gate: none")
        self.assertEqual(nondev_copy.deliver_comment("", "/d", "/e", False),
                         "Deliverable ready | summary not given · /d · evidence /e | next gate: Josh's sign-off")

    def test_a_question_that_ends_in_a_mark_gets_no_extra_stop(self):
        text = nondev_copy.ping_before("JP-1", "Is it x?", "a note", "it fits")
        self.assertEqual(text, 'JP-1: before I start. Question: Is it x? I\'ll deliver a note, assuming it fits. '
                               'Is that right? One sentence is enough, or reply "go".')
        self.assertIn("Question: Is it x. I'll", nondev_copy.ping_before("JP-1", "Is it x", "a", "b"))


class Screen(unittest.TestCase):
    def test_a_write_is_refused_by_kind_never_by_text(self):
        with self.assertRaises(GateError) as caught:
            screened("call me on 555-123-4567")
        self.assertIn("phone", str(caught.exception))
        self.assertNotIn("555", str(caught.exception))

    def test_say_screens_before_it_posts(self):
        class Port:
            posted = []

            def comments(self, key):
                return []

            def comment(self, key, text):
                self.posted.append(text)
        port = Port()
        with self.assertRaises(GateError):
            say(port, "JP-1", "MRN 1234")
        self.assertEqual(port.posted, [])


class FakeJira:
    """The calls of lib/jira.py's Jira that JiraPort uses, with its return shapes."""

    def __init__(self, **ok):
        self.ok = dict({"get": True, "comments": True, "comment": True, "transition": True, "set_flag": True}, **ok)

    def get(self, key, fields=None):
        return {"key": key, "status": "Ready", "description": "Question: q"} if self.ok["get"] else None

    def get_property(self, key, name):
        return {"graph": "non-development"}

    def comments(self, key):
        return [{"id": "1", "author": "Josh", "body": "hello", "created": "now"}] if self.ok["comments"] else None

    def comment(self, key, text):
        return self.ok["comment"]

    def transition(self, key, status):
        return self.ok["transition"]

    def set_flag(self, key, on):
        return self.ok["set_flag"]


class JiraPortCase(unittest.TestCase):
    def test_reads_map_to_the_gate_types(self):
        port = ticket_port.JiraPort(FakeJira())
        ticket = port.read("JP-1")
        self.assertEqual((ticket.status, ticket.route), ("Ready", {"graph": "non-development"}))
        self.assertEqual(port.comments("JP-1")[0].body, "hello")

    def test_every_unconfirmed_call_becomes_a_gate_error(self):
        for call, invoke in (("get", lambda p: p.read("JP-1")), ("comments", lambda p: p.comments("JP-1")),
                             ("comment", lambda p: p.comment("JP-1", "x")), ("transition", lambda p: p.move("JP-1", "Done")),
                             ("set_flag", lambda p: p.set_flag("JP-1", True))):
            with self.assertRaises(GateError, msg=call):
                invoke(ticket_port.JiraPort(FakeJira(**{call: False if call not in ("get", "comments") else None})))


class OutlookDraft(Case):
    def tool(self):
        tool = self.root / "outlook_tool.py"
        tool.write_text("# fake")
        return tool

    def test_the_draft_command_is_used_and_never_send(self):
        body = self.root / "JP-1-answer.md"
        body.write_text("# <Answer> & more")
        seen = {}

        def fake_run(argv, **kwargs):
            seen["argv"] = argv
            seen["html"] = Path(argv[argv.index("--body-file") + 1]).read_text()
            return subprocess.CompletedProcess(argv, 0, "", "")
        with mock.patch.object(ticket_port.subprocess, "run", fake_run):
            ticket_port.outlook_draft("a@b.co", "JP-1: x", body, {"JOSH360_OUTLOOK_TOOL": str(self.tool())})
        argv = seen["argv"]
        self.assertEqual(argv[2:4], ["draft", "--to"])
        self.assertIn("a@b.co", argv)
        self.assertNotIn("send", argv)
        self.assertIn("&lt;Answer&gt; &amp; more", seen["html"])      # the deliverable's text is escaped

    def test_a_binary_deliverable_gets_a_note_naming_its_path(self):
        sheet = self.root / "JP-1-table.xlsx"
        sheet.write_bytes(b"\x00\x01")
        self.assertIn("The file is at", ticket_port.draft_html(sheet))

    def test_no_tool_raises(self):
        with self.assertRaises(GateError):
            ticket_port.outlook_draft("a@b.co", "s", self.root / "x.md", {"JOSH360_OUTLOOK_TOOL": "/nope", "HOME": "/nope"})

    def test_a_failed_tool_raises(self):
        body = self.root / "JP-1-answer.md"
        body.write_text("x")
        with mock.patch.object(ticket_port.subprocess, "run",
                               lambda argv, **kw: subprocess.CompletedProcess(argv, 3, "", "")):
            with self.assertRaises(GateError):
                ticket_port.outlook_draft("a@b.co", "s", body, {"JOSH360_OUTLOOK_TOOL": str(self.tool())})


if __name__ == "__main__":
    unittest.main()
