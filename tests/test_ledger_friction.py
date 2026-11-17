"""JP-112: friction facts. Made-up transcripts, folders, tickets and commands only; no network, no model."""
import io
import json
import socket
import sys
import time
import calendar
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ledger_transcripts as tr  # noqa: E402
from ledger_helpers import FAKE_PHONE, NOW, ROOT, LedgerCase  # noqa: E402
from test_ledger_homes import CONV  # noqa: E402
import test_ledger_record as base  # noqa: E402
from test_ledger_record import FOLDER, fake_git, jira_ok  # noqa: E402
from ledger import friction, friction_write, record  # noqa: E402

SID = "sess-0001"
SECRET_REPLY = "the sample answer about the blue widget"
SECRET_COMMAND = "pytest --made-up-flag-xyzzy"
SECRET_FILE = "/tmp/made-up/josh_360/secret_widget_notes.py"
NOW_EPOCH = calendar.timegm(time.strptime(NOW, "%Y-%m-%dT%H:%M:%SZ"))


def at(minute, second=0):
    return "2026-11-17T09:{:02d}:{:02d}Z".format(minute, second)


def human(stamp, text):
    return json.dumps({"type": "user", "timestamp": stamp, "sessionId": SID, "isSidechain": False,
                       "message": {"role": "user", "content": text}})


def said(stamp, text, usage=None, model="claude-made-up"):
    message = {"role": "assistant", "model": model, "content": [{"type": "text", "text": text}]}
    if usage:
        message["usage"] = usage
    return json.dumps({"type": "assistant", "timestamp": stamp, "sessionId": SID, "isSidechain": False,
                       "message": message})


def called(stamp, tool_id, name, **given):
    return json.dumps({"type": "assistant", "timestamp": stamp, "sessionId": SID, "isSidechain": False,
                       "message": {"role": "assistant", "model": "claude-made-up",
                                   "content": [{"type": "tool_use", "id": tool_id, "name": name, "input": given}]}})


def result(stamp, tool_id, text="ok", error=False):
    return json.dumps({"type": "user", "timestamp": stamp, "sessionId": SID, "isSidechain": False,
                       "message": {"role": "user", "content": [
                           {"type": "tool_result", "tool_use_id": tool_id, "content": text, "is_error": error}]}})


def system(stamp, **extra):
    return json.dumps(dict({"type": "system", "timestamp": stamp, "sessionId": SID, "isSidechain": False}, **extra))


def story():
    """One made-up session that has every kind of friction once or more."""
    return [
        human(at(0), "please tidy the made-up widget"),                                      # unprompted
        said(at(1), "Hello. Which widget do you mean?",
             {"input_tokens": 1000, "cache_creation_input_tokens": 9000, "cache_read_input_tokens": 40000}),
        human(at(3), SECRET_REPLY),                                                          # answer (after a "?")
        called(at(4), "t1", "Bash", command=SECRET_COMMAND),
        result(at(4, 10), "t1", "boom", error=True),                                         # failed
        called(at(5), "t2", "Bash", command=SECRET_COMMAND),
        result(at(5, 10), "t2", "boom", error=True),                                         # failed again (repeat)
        called(at(6), "t3", "Bash", command="ls"),
        result(at(6, 10), "t3", "nope", error=True),                                         # failed, different
        called(at(7), "t4", "Bash", command="make"),
        result(at(7, 10), "t4", "The user doesn't want to proceed with this tool use.", error=True),  # not a failure
        called(at(8), "r1", "Read", file_path=SECRET_FILE),
        called(at(8, 5), "r2", "Read", file_path=SECRET_FILE),
        called(at(8, 10), "r3", "Read", file_path=SECRET_FILE),
        called(at(8, 15), "r4", "Read", file_path="/tmp/made-up/other.py"),
        called(at(9), "q1", "AskUserQuestion", questions=[{"question": "Which?"}]),
        result(at(11), "q1", "User has answered your questions: blue"),                      # answer by tool
        human(at(12), "[Request interrupted by user]"),                                      # interrupt
        human(at(12, 30), "<local-command-stdout>sample</local-command-stdout>"),            # not Josh
        called(at(13), "s1", "Skill", skill="superpowers:brainstorming"),
        called(at(13, 5), "a1", "Agent", subagent_type="Explore", description="look"),
        called(at(13, 10), "m1", "mcp__github__get_file_contents", path="x"),
        system(at(14), subtype="compact_boundary"),
        said(at(15), "All done."),
        human(at(20), "thanks, now ship it"),                                                # unprompted
    ]


class Reader(LedgerCase):
    def read(self, lines, **kw):
        path = tr.write(self.tmp / "t" / (SID + ".jsonl"), lines)
        return friction.read(path, **kw)

    def test_every_count(self):
        facts = self.read(story())
        self.assertEqual(facts.counts, {
            "josh_messages_unprompted": 2, "josh_messages_answer": 2, "josh_interrupts": 1,
            "failed_commands": 3, "repeat_failed_commands": 1, "max_reads_of_one_file": 3,
            "context_first_turn_pct": 25, "compactions": 1,
            "seconds_waiting_on_josh": 120 + 120 + 300, "seconds_working": 660})

    def test_working_and_waiting_add_up_the_gaps(self):
        facts = self.read([human(at(0), "go"), said(at(1), "done."), human(at(11), "more"), said(at(12), "ok.")])
        # waiting: the 10 minutes before the second human line; working: 1 minute each side of it, none else
        self.assertEqual(facts.counts["seconds_waiting_on_josh"], 600)
        self.assertEqual(facts.counts["seconds_working"], 120)

    def test_a_long_silence_counts_for_a_capped_time(self):
        facts = self.read([said("2026-11-10T09:00:00Z", "ready."), human("2026-11-17T09:00:00Z", "back"),
                           said("2026-11-17T10:00:00Z", "ok.")])
        self.assertEqual(facts.counts["seconds_waiting_on_josh"], friction.WAIT_CAP_SECONDS)
        self.assertEqual(facts.counts["seconds_working"], friction.WORK_CAP_SECONDS)

    def test_usage_by_name(self):
        facts = self.read(story())
        self.assertEqual(facts.usage[("skill", "superpowers:brainstorming")], [1, 1])
        self.assertEqual(facts.usage[("agent", "Explore")], [1, 1])
        self.assertEqual(facts.usage[("mcp-server", "github")], [1, 1])
        self.assertEqual(facts.usage[("tool", "Bash")], [1, 4])
        self.assertEqual(facts.usage[("tool", "Skill")], [1, 1])
        self.assertNotIn(("tool", "mcp__github__get_file_contents"), facts.usage)

    def test_a_script_prompt_is_not_josh(self):
        facts = self.read(story(), who="scripted")
        self.assertNotIn("josh_messages_unprompted", facts.counts)
        self.assertEqual(facts.counts["josh_messages_answer"], 1)   # his answer to the dialog is still his
        self.assertEqual(facts.counts["seconds_waiting_on_josh"], 120)   # only the dialog's answer
        self.assertEqual(facts.counts["failed_commands"], 3)

    def test_a_subagent_has_no_josh_in_it(self):
        facts = self.read(story(), who="subagent")
        for code in ("josh_messages_unprompted", "josh_messages_answer", "seconds_waiting_on_josh"):
            self.assertNotIn(code, facts.counts)
        self.assertEqual(facts.counts["failed_commands"], 3)

    def test_sidechain_lines_are_not_counted_unless_it_is_the_subagents_own_file(self):
        side = json.loads(called(at(1), "t9", "Bash", command="ls"))
        side["isSidechain"] = True
        lines = [human(at(0), "go"), json.dumps(side), result(at(2), "t9", "x", error=True)]
        self.assertNotIn(("tool", "Bash"), self.read(lines).usage)
        self.assertIn(("tool", "Bash"), self.read(lines, who="subagent").usage)

    def test_context_window_follows_the_model(self):
        big = {"input_tokens": 100, "cache_read_input_tokens": 300000}
        self.assertEqual(self.read([said(at(1), "a.", big)]).counts["context_first_turn_pct"], 30)
        small = {"input_tokens": 100}
        self.assertEqual(self.read([said(at(1), "a.", small)]).counts["context_first_turn_pct"], 1)
        marked = {"input_tokens": 100000}
        self.assertEqual(self.read([said(at(1), "a.", marked, model="claude-made-up[1m]")]
                                   ).counts["context_first_turn_pct"], 10)

    def test_the_context_running_out_is_counted(self):
        line = json.loads(said(at(2), "Prompt is too long"))
        line["isApiErrorMessage"] = True
        facts = self.read([said(at(1), "a."), json.dumps(line)])
        self.assertEqual(facts.counts["context_exhausted"], 1)

    def test_loaded_lists_are_read_when_the_transcript_has_them(self):
        listing = {"type": "attachment", "timestamp": at(0), "attachment": {
            "type": "skill_listing", "content": "- alpha: does a\n- beta:gamma: does b\nnot a listing line"}}
        servers = {"type": "attachment", "timestamp": at(0), "attachment": {
            "type": "mcp_instructions_delta", "addedNames": ["github", "made up server!"]}}
        facts = self.read([json.dumps(listing), json.dumps(servers), called(at(1), "s1", "Skill", skill="alpha")])
        self.assertEqual(facts.usage[("skill", "alpha")], [1, 1])
        self.assertEqual(facts.usage[("skill", "beta:gamma")], [1, 0])
        self.assertEqual(facts.usage[("mcp-server", "github")], [1, 0])
        self.assertNotIn(("mcp-server", "made up server!"), facts.usage)

    def test_names_that_are_not_plain_identifiers_are_dropped(self):
        lines = [called(at(1), "s1", "Skill", skill="free text, not a name"),
                 called(at(2), "s2", "Skill", skill=FAKE_PHONE),
                 called(at(3), "a1", "Agent", subagent_type="x" * 200)]
        facts = self.read(lines)
        self.assertFalse([k for k in facts.usage if k[0] in ("skill", "agent")])

    def test_time_range_and_byte_range(self):
        lines = story()
        path = tr.write(self.tmp / "t" / (SID + ".jsonl"), lines)
        early = friction.read(path, until=at(5, 30))
        self.assertEqual(early.counts["failed_commands"], 2)
        first_two = len(("\n".join(lines[:2]) + "\n").encode("utf-8"))
        part = friction.read(path, end_offset=first_two)
        self.assertEqual(part.counts["josh_messages_unprompted"], 1)
        self.assertNotIn("failed_commands", part.counts)

    def test_broken_and_unfinished_lines_are_skipped(self):
        path = tr.write(self.tmp / "t" / (SID + ".jsonl"),
                        [human(at(0), "go"), "{not json", '"a string"', human(at(1), "more")], newline_at_end=False)
        facts = friction.read(path)
        self.assertEqual(facts.skipped, 2)
        self.assertEqual(facts.counts["josh_messages_unprompted"], 1)   # the last line has no newline yet

    def test_unknown_who_is_refused(self):
        with self.assertRaises(ValueError):
            self.read([human(at(0), "go")], who="agent")

    def test_who_for(self):
        self.assertEqual(friction.who_for("walker", False), "scripted")
        self.assertEqual(friction.who_for("josh-360", False), "scripted")
        self.assertEqual(friction.who_for("agent-manager", False), "josh")
        self.assertEqual(friction.who_for("unknown", False), "josh")
        self.assertEqual(friction.who_for("walker", True), "subagent")


class InstructionFiles(LedgerCase):
    def test_sizes_up_the_folder_chain_and_counts_a_link_once(self):
        claude = self.tmp / "claude"
        claude.mkdir()
        (claude / "CLAUDE.md").write_text("a" * 100)
        (claude / "rules").mkdir()
        (claude / "rules" / "one.md").write_text("b" * 10)
        repo = self.tmp / "work" / "repo"
        (repo / "sub").mkdir(parents=True)
        (repo / "AGENTS.md").write_text("c" * 1000)
        (repo / "CLAUDE.md").symlink_to(repo / "AGENTS.md")
        (self.tmp / "work" / "CLAUDE.md").write_text("d" * 5)
        files = friction.instruction_files(str(repo / "sub"), claude)
        self.assertEqual(sorted(size for _, size in files), [5, 10, 100, 1000])

    def test_nothing_there_is_nothing_counted(self):
        self.assertEqual(friction.instruction_files("/tmp/made-up/not-here", self.tmp / "empty"), [])
        self.assertEqual(friction.instruction_files(None, self.tmp / "empty"), [])


class Writer(LedgerCase):
    def setUp(self):
        super().setUp()
        self.uid = self.session()
        self.episode(self.uid)

    def facts(self, counts, usage=None):
        return friction.Facts(counts=counts, usage=usage or {})

    def test_writes_numbers_under_listed_codes_and_skips_zero(self):
        wrote = friction_write.record_episode(self.conn, self.uid, 1, self.facts(
            {"josh_interrupts": 2, "failed_commands": 0}), NOW, instructions=[("~/CLAUDE.md", 40), ("/x/CLAUDE.md", 2)])
        self.assertEqual(wrote, {"facts": 2, "usage": 2})
        self.assertEqual(self.rows("SELECT fact, value FROM session_facts ORDER BY fact"),
                         [("instruction_bytes_loaded", 42), ("josh_interrupts", 2)])
        self.assertEqual(self.rows("SELECT item_kind, item_name, loaded, uses FROM session_usage ORDER BY item_name"),
                         [("rule-file", "/x/CLAUDE.md", 1, 0), ("rule-file", "~/CLAUDE.md", 1, 0)])

    def test_a_code_that_is_not_listed_is_refused_and_nothing_is_written(self):
        with self.assertRaises(ValueError):
            friction_write.record_episode(self.conn, self.uid, 1, self.facts({"josh_interrupts": 1, "mood": 3}), NOW)
        self.assertEqual(self.count("session_facts"), 0)

    def test_writing_twice_writes_once(self):
        used = {("skill", "alpha"): [1, 2]}
        for _ in range(2):
            friction_write.record_episode(self.conn, self.uid, 1, self.facts({"josh_interrupts": 2}, used), NOW)
        self.assertEqual((self.count("session_facts"), self.count("session_usage")), (1, 1))

    def test_every_code_the_reader_can_write_is_listed(self):
        codes = friction_write.fact_codes()
        facts = friction.read(tr.write(self.tmp / "t" / "s.jsonl", story()))
        self.assertLessEqual(set(facts.counts), set(codes))

    def test_a_path_that_fails_the_screen_is_counted_but_not_named(self):
        friction_write.record_episode(self.conn, self.uid, 1, self.facts({}),
                                      NOW, instructions=[("/x/{}/CLAUDE.md".format(FAKE_PHONE), 7)])
        self.assertEqual(self.count("session_usage"), 0)
        self.assertEqual(self.rows("SELECT value FROM session_facts"), [(7,)])


class RecorderTools(LedgerCase):
    """The recorder test helpers, without running the recorder's own tests a second time."""
    tfile = base.Recorder.tfile
    start = base.Recorder.start
    end = base.Recorder.end
    run_pass = base.Recorder.run_pass

    def setUp(self):
        super().setUp()
        self.spool = self.tmp / "spool"
        self.projects = self.tmp / "projects"
        self.state = {"spool": {"file": "", "offset": 0}, "sessions": {}}


class Wired(RecorderTools):
    """The recorder writes the facts with the episode."""

    def session_with_story(self, started_by="josh", folder=FOLDER):
        self.start(started_by=started_by, folder=folder)
        self.end()
        tr.write(self.tfile(), story(), mtime=NOW_EPOCH - 60)

    def facts(self):
        return dict(self.rows("SELECT fact, value FROM session_facts"))

    def test_a_session_of_josh_gets_its_friction_facts(self):
        self.session_with_story()
        self.run_pass()
        self.assertEqual(self.facts()["josh_messages_unprompted"], 2)
        self.assertEqual(self.facts()["failed_commands"], 3)
        self.assertEqual(self.facts()["compactions"], 1)   # written once, by one writer
        self.assertEqual(self.rows("SELECT COUNT(*) FROM session_facts WHERE fact = 'compactions'"), [(1,)])
        self.assertIn(("skill", "superpowers:brainstorming"),
                      self.rows("SELECT item_kind, item_name FROM session_usage"))

    def test_a_script_session_records_no_message_of_josh(self):
        self.session_with_story(started_by="walker")
        self.run_pass()
        self.assertNotIn("josh_messages_unprompted", self.facts())
        self.assertEqual(self.facts()["failed_commands"], 3)

    def test_the_instruction_size_is_counted_when_the_claude_home_is_named(self):
        self.session_with_story()
        home = self.tmp / "claude-home"
        home.mkdir()
        (home / "CLAUDE.md").write_text("x" * 321)
        record.record_pass(self.conn, now=NOW, spool=self.spool, projects=self.projects, git=fake_git, jira=jira_ok,
                           conventions=CONV, state=self.state, claude_home=home)
        self.assertEqual(self.facts()["instruction_bytes_loaded"], 321)

    def test_a_phi_folder_keeps_counts_but_no_text(self):
        folder = "/tmp/made-up/.phi/export"
        self.session_with_story(folder=folder)
        self.run_pass()
        self.assertEqual(self.facts()["josh_messages_unprompted"], 2)
        self.assertNotIn(SECRET_REPLY, self.dump())

    def test_no_message_command_or_file_text_reaches_the_ledger(self):
        self.session_with_story()
        self.run_pass()
        dump = self.dump()
        for secret in (SECRET_REPLY, SECRET_COMMAND, SECRET_FILE, "secret_widget", "please tidy", "ship it",
                       "Hello. Which widget", "boom"):
            self.assertNotIn(secret, dump)
        for table in ("session_facts", "session_usage"):
            kinds = {row[1]: row[2] for row in self.rows("PRAGMA table_info({})".format(table))}
            self.assertFalse([c for c in kinds if c in ("text", "message", "content", "command", "output")], kinds)

    def test_a_failure_writing_friction_never_stops_the_episode(self):
        self.session_with_story()
        with mock.patch.object(friction, "read", side_effect=RuntimeError("made-up trouble")):
            counts = self.run_pass()
        self.assertEqual(counts["episodes"], 1)
        self.assertEqual(self.count("session_facts"), 1)       # only the compaction the recorder writes itself

    def test_a_bad_code_rolls_back_the_facts_of_that_episode_only(self):
        self.session_with_story()
        bad = friction.Facts(counts={"josh_interrupts": 1, "mood": 2})
        with mock.patch.object(friction, "read", return_value=bad):
            counts = self.run_pass()
        self.assertEqual(counts["episodes"], 1)
        self.assertNotIn("josh_interrupts", self.facts())

    def test_no_model_and_no_network(self):
        self.session_with_story()
        with mock.patch.object(socket, "socket", side_effect=AssertionError("network used")), \
                mock.patch.object(socket, "create_connection", side_effect=AssertionError("network used")):
            self.run_pass()
        self.assertEqual(self.facts()["failed_commands"], 3)

    def test_the_modules_import_nothing_that_can_reach_a_model(self):
        for name in ("friction.py", "friction_write.py", "measures.py"):
            source = (ROOT / "ledger" / name).read_text(encoding="utf-8")
            for banned in ("import socket", "import urllib", "import http", "import requests", "anthropic", "openai",
                           "subprocess", "claude -p", "import ssl"):
                self.assertNotIn(banned, source, (name, banned))

    def dump(self):
        return "\n".join(self.conn.iterdump())


class CatchUp(RecorderTools):
    def setUp(self):
        super().setUp()
        self.start(started_by="josh")
        self.end()
        tr.write(self.tfile(), story(), mtime=NOW_EPOCH - 60)
        with mock.patch.object(friction_write, "record_episode", side_effect=RuntimeError("not yet built")):
            self.run_pass()
        self.assertEqual(self.rows("SELECT fact FROM session_facts"), [("compactions",)])

    def catch_up(self):
        return friction_write.catch_up(self.conn, projects=self.projects, now=NOW, claude_home=self.tmp / "claude")

    def test_an_episode_recorded_before_gets_its_facts_from_its_own_time_range(self):
        counts = self.catch_up()
        self.assertEqual((counts["episodes"], counts["errors"], counts["no_transcript"]), (1, 0, 0))
        facts = dict(self.rows("SELECT fact, value FROM session_facts"))
        self.assertEqual((facts["josh_messages_unprompted"], facts["failed_commands"]), (2, 3))

    def test_a_second_pass_writes_nothing_new(self):
        self.catch_up()
        before = self.count("session_facts"), self.count("session_usage")
        self.assertEqual(self.catch_up()["facts"], 0)
        self.assertEqual((self.count("session_facts"), self.count("session_usage")), before)

    def test_a_transcript_that_is_gone_is_counted_and_left(self):
        self.tfile().unlink()
        counts = self.catch_up()
        self.assertEqual((counts["episodes"], counts["no_transcript"]), (0, 1))


class AgentsCannotSeeTheMeasures(LedgerCase):
    """Scenario: working agents cannot see the measures. The only command they are given is ask.py."""

    def test_ask_never_names_a_friction_table_or_a_measure(self):
        import ast
        source = (ROOT / "ledger" / "ask.py").read_text(encoding="utf-8")
        code = source.replace(ast.get_docstring(ast.parse(source), clean=False) or "", "")
        for name in ("session_facts", "session_usage", "measures", "friction", "debrief", "session_costs",
                     "step_costs", "current_session_costs"):
            self.assertNotIn(name, code)

    def test_no_answer_from_ask_holds_a_friction_value_or_a_usage_name(self):
        from ledger import ask
        uid = self.session()
        self.conn.execute(
            "INSERT INTO session_episodes (session_uid, episode, began_at, last_activity_at, quiet_at, end_reason, "
            "folder, repo, branch, title, title_source, recorded_at, recorded_by) "
            "VALUES (?, 1, ?, ?, ?, 'quiet', '/tmp/made-up/josh_360', 'o/josh-360', 'JP-900/x', 't', 'ai', ?, 'test')",
            (uid, "2026-11-17T09:00:00Z", "2026-11-17T09:10:00Z", "2026-11-17T09:40:00Z", NOW))
        self.conn.execute("INSERT INTO ticket_links (session_uid, tracker, ticket_key, relation, source, linked_at, "
                          "recorded_by) VALUES (?, 'jira', 'JP-900', 'touched', 'branch', ?, 't')", (uid, NOW))
        friction_write.record_episode(self.conn, uid, 1, friction.Facts(
            counts={"josh_interrupts": 4242, "failed_commands": 4343}, usage={("skill", "zz-unique-skill"): [1, 9]}),
            NOW)
        for argv in (["ticket", "--key", "JP-900"], ["find", "--folder", "/tmp/made-up/josh_360"],
                     ["home", "--session", SID]):
            out = io.StringIO()
            ask.main(argv, out, self.path)
            for needle in ("4242", "4343", "zz-unique-skill", "josh_interrupts"):
                self.assertNotIn(needle, out.getvalue(), argv)


if __name__ == "__main__":
    unittest.main()
