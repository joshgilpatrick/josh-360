"""JP-108: session summaries. Made-up sessions, transcripts, STATE.md files and a fake model only; no network."""
import json
import os
import sqlite3
import stat
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ledger_transcripts as tr  # noqa: E402
import test_ledger_record as rec  # noqa: E402
from ledger_helpers import FAKE_PHONE, NOW, ROOT, T, LedgerCase  # noqa: E402
from ledger import spool, summary, summary_sources  # noqa: E402

FOLDER = rec.FOLDER
BRANCH = "JP-900/sample-work"
TAGGED = "<command-name>/made-up</command-name>"  # text the tools inject: never a first line


def user(at, content, folder=FOLDER, **extra):
    return json.dumps({"type": "user", "timestamp": at, "sessionId": "sess-0001", "uuid": "u-" + at,
                       "isSidechain": False, "cwd": folder, "gitBranch": BRANCH,
                       "message": {"role": "user", "content": content}, **extra})


def transcript(first="Draft the made-up widget plan\nsecond line of the message", title=None, folder=FOLDER):
    lines = [user("2026-11-17T09:00:00Z", first, folder),
             tr.line("assistant", "2026-11-17T09:01:00Z", cwd=folder, gitBranch=BRANCH)]
    if title:
        lines.append(tr.line("ai-title", "2026-11-17T09:01:30Z", aiTitle=title))
    lines.append(tr.line("assistant", "2026-11-17T09:10:00Z", cwd=folder, gitBranch=BRANCH))
    return lines


STATE = ("## Status\n- working\n\n## U-turns\n- a -> b: because; told the user yes\n\n## Dead ends\n- x: y; do not retry\n"
         "\n## Timeline\n- User request: build the made-up widget plan\n  - Status: plan written and checked\n")


class FakeModel:
    def __init__(self, text="Asked: a made-up request\nOutcome: it was answered", cost=0.002, fail_first=0):
        self.prompts, self.attempts, self.text, self.cost, self.fail_first = [], [], text, cost, fail_first

    def __call__(self, prompt, attempt):
        self.prompts.append(prompt)
        self.attempts.append(attempt)
        if len(self.attempts) <= self.fail_first:
            return None
        return summary.CallResult(self.text, "model-" + str(attempt), 120, 30, self.cost)


def no_call(prompt, attempt):
    raise AssertionError("a model was called")


class Summaries(LedgerCase):
    tfile, end = rec.Recorder.tfile, rec.Recorder.end  # the recorder tests' helpers

    def start(self, *args, started_by="josh", **kw):
        """Josh's own sessions: a walker's session is part of a graph run and earns a debrief (JP-113), which
        tests/test_ledger_debrief.py covers."""
        return rec.Recorder.start(self, *args, started_by=started_by, **kw)

    def setUp(self):
        super().setUp()
        self.spool = self.tmp / "spool"
        self.projects = self.tmp / "projects"
        self.state = {"spool": {"file": "", "offset": 0}, "sessions": {}}
        self.claude_home = self.tmp / "claude-home"

    def run_pass(self, now=NOW, **kw):
        return rec.record.record_pass(self.conn, now=now, spool=self.spool, projects=self.projects, git=rec.fake_git,
                                      jira=rec.jira_ok, conventions=rec.CONV, state=self.state,
                                      claude_home=self.claude_home)

    def state_md(self, text=STATE, sid="sess-0001"):
        path = self.claude_home / "session-state" / sid / "STATE.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def quiet(self, lines=None, folder=FOLDER, sid="sess-0001", mtime=rec.NOW_EPOCH - 3600, ended=False):
        self.start(sid=sid, folder=folder)
        if ended:
            self.end(sid=sid)
        tr.write(self.tfile(sid), lines or transcript(), mtime=mtime)
        self.run_pass()

    def summarise(self, call, **kw):
        # No thresholds: these tests are about the summary, and the STATE.md they use has a U-turn, which would earn a
        # debrief (tests/test_ledger_debrief.py covers that).
        form = {"form_version": "t", "status": "provisional", "max_moments": 5, "friction_thresholds": {}}
        return summary.summarise_pending(self.conn, NOW, call=call, claude_home=self.claude_home, form=form, **kw)

    def lines(self, episode=None):
        sql = "SELECT lines FROM session_summaries" + (" WHERE episode = {}".format(episode) if episode else "")
        return [r[0].split("\n") for r in self.rows(sql + " ORDER BY episode, version")]

    # -- the ticket's scenarios ---------------------------------------------------------------------------

    def test_enough_material_means_no_model(self):
        """JP-108 scenario 1, with the first line copied."""
        self.state_md()
        self.quiet(transcript(title="A made-up widget plan"))
        counts = self.summarise(no_call)
        self.assertEqual((counts["copied"], counts["calls"]), (1, 0))
        lines = self.lines()[0]
        self.assertEqual(lines[0], "Asked: Draft the made-up widget plan")
        self.assertIn("About: A made-up widget plan", lines)
        self.assertIn("Status: plan written and checked", lines)
        self.assertTrue(lines[-2].startswith("Work: JP-900") and "branch JP-900/sample-work" in lines[-2])
        self.assertTrue(lines[-1].startswith("Ended: went quiet"))
        self.assertIn("1 U-turn, 1 dead end", lines[-1])
        self.assertEqual(self.rows("SELECT method, model_call_id, lines_withheld FROM session_summaries"),
                         [("copied", None, 0)])
        self.assertEqual(self.count("model_calls"), 0)

    def test_a_title_and_a_timeline_are_enough_without_a_first_line(self):
        self.state_md()
        self.quiet(transcript(first=TAGGED, title="A made-up widget plan"))
        self.assertEqual(self.summarise(no_call)["calls"], 0)
        lines = self.lines()[0]
        self.assertEqual(lines[0], "About: A made-up widget plan")
        self.assertEqual(self.count("model_calls"), 0)

    def test_a_question_only_session_is_described_by_its_first_line(self):
        self.quiet(transcript(first="What does the made-up widget do?"))
        self.assertEqual(self.summarise(no_call)["copied"], 1)
        self.assertEqual(self.lines()[0][0], "Asked: What does the made-up widget do?")

    def test_thin_material_means_one_call_and_its_cost_is_recorded(self):
        """JP-108 scenario 2."""
        self.quiet(transcript(first=TAGGED))
        model = FakeModel()
        counts = self.summarise(model)
        self.assertEqual((counts["model"], counts["calls"], len(model.prompts)), (1, 1, 1))
        self.assertEqual(self.rows("SELECT purpose, model, input_tokens, output_tokens, cost_usd, called_at "
                                   "FROM model_calls"), [("summary", "model-0", 120, 30, 0.002, NOW)])
        self.assertEqual(self.rows("SELECT method, model_call_id FROM session_summaries"), [("model", 1)])
        lines = self.lines()[0]
        self.assertEqual(lines[:2], ["Asked: a made-up request", "Outcome: it was answered"])
        self.assertTrue(lines[2].startswith("Work: ") and lines[3].startswith("Ended: "))
        self.assertEqual(self.rows("SELECT subject_session_uid FROM model_calls"), [(self.uid("sess-0001"),)])
        self.assertEqual(self.summarise(model)["calls"], 0)  # nothing is summarised twice, so nothing is called twice
        self.assertEqual(len(model.prompts), 1)

    def test_the_call_gets_a_short_excerpt_and_the_facts_never_more(self):
        long_text = "word " * 500
        self.quiet([user("2026-11-17T09:00:00Z", "call about {}".format(FAKE_PHONE)),
                    user("2026-11-17T09:00:30Z", long_text)] + transcript(first=TAGGED)[1:])
        model = FakeModel()
        self.summarise(model)
        prompt = model.prompts[0]
        self.assertNotIn(FAKE_PHONE, prompt)  # a message that fails the screen is not sent either
        self.assertIn("[user] " + "word " * 79 + "word", prompt)
        self.assertNotIn("word " * 100, prompt)
        self.assertIn("JP-900/sample-work", prompt)
        self.assertLess(len(prompt), 4500)

    def test_a_resumed_session_is_summarised_again(self):
        """JP-108 scenario 3."""
        self.state_md()
        self.start()
        self.end()
        path = tr.write(self.tfile(), transcript(), mtime=rec.NOW_EPOCH - 7200)
        self.run_pass(now="2026-11-17T10:00:00Z")
        self.summarise(no_call)
        first = self.lines(1)[0]
        self.state_md(STATE + "- User request: a second made-up request\n  - Status: second request done\n")
        self.start(source="resume", at="2026-11-17T11:00:00Z")
        tr.append(path, [user("2026-11-17T11:01:00Z", "continue the plan"),
                         tr.line("assistant", "2026-11-17T11:02:00Z", cwd=FOLDER, gitBranch=BRANCH)],
                  mtime=rec.NOW_EPOCH - 3000)
        self.run_pass()
        self.assertEqual(self.summarise(no_call)["copied"], 1)
        self.assertEqual(self.lines(1)[0], first)  # the earlier stretch is not rewritten
        second = self.lines(2)[0]
        self.assertNotEqual(second, first)
        self.assertIn("Status (latest of 2 requests): second request done", second)
        self.assertIn("Ended: ", second[-1])
        self.assertIn("(stretch 2)", second[-1])
        self.assertEqual(self.rows("SELECT episode FROM current_session_summaries ORDER BY episode"), [(1,), (2,)])

    def test_a_closed_terminal_still_gets_its_summary(self):
        """JP-108 scenario 4: no SessionEnd, no closeout step; only the quiet period passes."""
        self.start()
        tr.write(self.tfile(), transcript(), mtime=rec.NOW_EPOCH - 1801)
        self.run_pass()
        self.assertEqual(self.rows("SELECT end_reason FROM session_episodes"), [("quiet",)])
        self.assertEqual(self.summarise(no_call)["copied"], 1)
        self.assertTrue(self.lines()[0][-1].startswith("Ended: went quiet"))

    def test_a_session_that_is_still_working_has_no_summary(self):
        self.start()
        tr.write(self.tfile(), transcript(), mtime=rec.NOW_EPOCH - 600)
        self.run_pass()
        self.assertEqual(self.summarise(no_call), {"copied": 0, "model": 0, "calls": 0, "failed": 0, "waiting": 0,
                                                    "skipped": 0, "debriefs": 0, "rejected": 0})

    # -- the limit -----------------------------------------------------------------------------------------

    def test_more_than_five_lines_or_800_characters_is_rejected(self):
        with self.assertRaises(ValueError):
            summary.check_lines(["a"] * 6)
        with self.assertRaises(ValueError):
            summary.check_lines(["a" * 300, "b" * 300, "c" * 300])
        with self.assertRaises(ValueError):
            summary.check_lines(["one\ntwo"])
        with self.assertRaises(ValueError):
            summary.check_lines([])
        summary.check_lines(["a"] * 5)
        uid = self.session()
        self.episode(uid)
        with self.assertRaises(sqlite3.IntegrityError):  # the schema refuses a sixth line as well
            self.conn.execute("INSERT INTO session_summaries (session_uid, episode, method, lines, written_at, "
                              "recorded_by) VALUES (?, 1, 'copied', ?, ?, 'test')", (uid, "\n".join("a" * 6), T))

    def test_the_worst_case_stays_inside_the_limit(self):
        m = summary.Material(uid="u", episode=3, phi=False, title="t" * 100, first="f" * 160,
                             timeline=[("r" * 150, "s" * 150)] * 2,
                             facts={"ticket": "JP-900", "system": "s" * 30, "branch": "b" * 90, "folder_name": "d" * 40,
                                    "turns": 9999, "commits": 99, "prs": 9, "files": 99, "end_reason": "session-end",
                                    "quiet_at": "2026-11-17T10:00:00Z", "minutes": 4000, "episode": 3, "u_turns": 9,
                                    "dead_ends": 9})
        lines, _ = summary.compose(m)
        self.assertEqual(len(lines), 5)
        self.assertLessEqual(len("\n".join(lines)), 800)

    def test_model_lines_are_cut_to_three_and_screened(self):
        lines, withheld = summary.parse_model_lines(
            "- Asked: first\n\n2. About: second {}\n* Outcome: third\n- Extra: fourth".format(FAKE_PHONE))
        self.assertEqual((lines, withheld), (["Asked: first", "Outcome: third"], 1))

    # -- patient data ------------------------------------------------------------------------------------

    def test_a_first_line_that_fails_the_screen_is_withheld_and_counted(self):
        self.state_md()
        self.quiet(transcript(first="call about {}".format(FAKE_PHONE), title="A made-up widget plan"))
        self.assertEqual(self.summarise(no_call)["calls"], 0)  # the title and the timeline are enough
        lines = self.lines()[0]
        self.assertFalse(any(FAKE_PHONE in line for line in lines))
        self.assertTrue(lines[0].startswith("About: "))
        self.assertEqual(self.rows("SELECT lines_withheld FROM session_summaries"), [(1,)])

    def test_a_first_line_that_fails_the_screen_and_a_thin_session_earns_the_call(self):
        self.quiet(transcript(first="call about {}".format(FAKE_PHONE)))
        model = FakeModel()
        self.summarise(model)
        self.assertEqual(len(model.prompts), 1)
        self.assertEqual(self.rows("SELECT method, lines_withheld FROM session_summaries"), [("model", 1)])

    def test_a_phi_folder_keeps_its_words_out_and_never_calls_a_model(self):
        folder = "/tmp/made-up/.phi/clinic_data"
        self.state_md()
        self.quiet(transcript(title="A made-up widget plan", folder=folder), folder=folder)
        self.assertEqual(self.summarise(no_call)["calls"], 0)
        lines = self.lines()[0]
        self.assertEqual(lines[0], "Words not kept: the folder is marked .phi")
        self.assertNotIn("widget", "\n".join(lines))
        self.assertEqual(len(lines), 3)

    def test_a_thin_phi_session_is_still_summarised_without_a_call(self):
        folder = "/tmp/made-up/.phi/clinic_data"
        self.quiet(transcript(first=TAGGED, folder=folder), folder=folder)
        self.assertEqual(self.summarise(no_call)["copied"], 1)

    # -- the call's limits -------------------------------------------------------------------------------

    def test_a_failed_call_is_tried_again_on_the_next_model_and_then_given_up(self):
        self.quiet(transcript(first=TAGGED))
        state = {}
        model = FakeModel(fail_first=2)
        self.assertEqual(self.summarise(model, state=state)["failed"], 1)
        self.assertEqual(self.count("session_summaries"), 0)
        self.assertEqual(self.summarise(model, state=state)["failed"], 1)
        self.assertEqual(model.attempts, [0, 1])  # the second try uses the tier's next model
        self.assertEqual(self.summarise(model, state=state), {"copied": 1, "model": 0, "calls": 0, "failed": 0,
                                                              "waiting": 0, "skipped": 0, "debriefs": 0,
                                                              "rejected": 0})
        self.assertEqual(len(model.prompts), 2)  # a third is never made
        self.assertEqual(self.rows("SELECT method FROM session_summaries"), [("copied",)])
        self.assertEqual(state["attempts"], {})

    def test_an_answer_with_no_usable_line_still_records_the_cost(self):
        self.quiet(transcript(first=TAGGED))
        self.summarise(FakeModel(text="   \n"))
        self.assertEqual(self.rows("SELECT method, model_call_id FROM session_summaries"), [("copied", None)])
        self.assertEqual(self.count("model_calls"), 1)

    def test_at_most_three_calls_in_one_run(self):
        for n in range(5):
            sid = "sess-{:04d}".format(n + 1)
            self.quiet(transcript(first=TAGGED), sid=sid)
        model = FakeModel()
        self.assertEqual(self.summarise(model, max_calls=3)["waiting"], 2)
        self.assertEqual((len(model.prompts), self.count("session_summaries")), (3, 3))
        self.summarise(model, max_calls=3)
        self.assertEqual((len(model.prompts), self.count("session_summaries")), (5, 5))

    def test_an_old_episode_never_earns_a_call(self):
        self.quiet(transcript(first=TAGGED))
        counts = summary.summarise_pending(self.conn, "2026-12-20T00:00:00Z", call=no_call,
                                           claude_home=self.claude_home)
        self.assertEqual((counts["copied"], counts["calls"]), (1, 0))

    def test_with_no_model_available_a_thin_session_gets_the_facts(self):
        self.quiet(transcript(first=TAGGED))
        self.assertEqual(self.summarise(None)["copied"], 1)
        self.assertEqual([line.split(":")[0] for line in self.lines()[0]], ["Work", "Ended"])

    def test_a_withdrawn_summary_is_not_written_again(self):
        self.quiet()
        self.summarise(no_call)
        self.conn.execute("INSERT INTO corrections (table_name, row_id, reason, corrected_by, corrected_at, recorded_by) "
                          "VALUES ('session_summaries', 1, 'wrong', 'josh', ?, 'test')", (NOW,))
        self.assertEqual(self.summarise(no_call)["copied"], 0)
        self.assertEqual(self.count("session_summaries"), 1)

    def test_a_subagent_gets_no_summary(self):
        self.quiet()
        sub = self.projects / "-made-up" / "sess-0001" / "subagents" / "agent-aa.jsonl"
        tr.write(sub, [tr.line("user", "2026-11-17T09:02:00Z", cwd=FOLDER, isSidechain=True),
                       tr.line("assistant", "2026-11-17T09:03:00Z", cwd=FOLDER, isSidechain=True)],
                 mtime=rec.NOW_EPOCH - 3600)
        self.run_pass()
        self.assertEqual(self.count("session_episodes"), 2)
        self.summarise(no_call)
        self.assertEqual(self.rows("SELECT session_uid FROM session_summaries"), [(self.uid("sess-0001"),)])

    def test_ask_find_shows_the_first_summary_line(self):
        from ledger import ask
        self.quiet()
        self.summarise(no_call)
        rows = ask.query(self.conn, "find", {"folder": FOLDER, "since": "2026-11-01"})
        self.assertEqual(rows[0]["summary_line"], "Asked: Draft the made-up widget plan")


class Sources(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.dir = Path(tempfile.mkdtemp(prefix="josh360-sum-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(str(self.dir), True))

    def write(self, lines):
        return tr.write(self.dir / "t.jsonl", lines)

    def test_the_first_line_skips_tool_results_tags_meta_and_sidechains(self):
        path = self.write([
            user("2026-11-17T09:00:00Z", [{"type": "tool_result", "content": "made-up output"}]),
            user("2026-11-17T09:00:01Z", "<system-reminder>made up</system-reminder>"),
            user("2026-11-17T09:00:02Z", "meta text", isMeta=True),
            user("2026-11-17T09:00:03Z", "side text", isSidechain=True),
            user("2026-11-17T09:00:04Z", [{"type": "text", "text": "\n  Real   first line  \nsecond"}]),
            user("2026-11-17T09:00:05Z", "a later message")])
        self.assertEqual(summary_sources.first_line(path), "Real first line")

    def test_the_first_line_is_cut_at_160_characters(self):
        path = self.write([user("2026-11-17T09:00:00Z", "x" * 400)])
        self.assertEqual(len(summary_sources.first_line(path)), 160)

    def test_a_missing_or_empty_transcript_has_no_first_line(self):
        self.assertIsNone(summary_sources.first_line(self.dir / "nope.jsonl"))
        self.assertIsNone(summary_sources.first_line(None))
        self.assertIsNone(summary_sources.first_line(self.write([user("2026-11-17T09:00:00Z", "   ")])))

    def test_a_line_still_being_written_is_not_read(self):
        path = self.dir / "t.jsonl"
        path.write_text(user("2026-11-17T09:00:00Z", "half a line"), encoding="utf-8")
        self.assertIsNone(summary_sources.first_line(path))

    def test_the_excerpt_is_bounded(self):
        path = self.write([user("2026-11-17T09:00:{:02d}Z".format(n), "message {} ".format(n) * 80)
                           for n in range(10)] + [tr.line("assistant", "2026-11-17T09:01:00Z")])
        out = summary_sources.excerpt(path)
        self.assertLessEqual(len([r for r, _ in out if r == "user"]), 4)
        self.assertLessEqual(sum(len(t) for _, t in out), 3000)
        self.assertTrue(all(len(t) <= 400 for _, t in out))

    def test_the_timeline_skips_the_template_placeholder(self):
        file = self.dir / "STATE.md"
        file.write_text("## Timeline\n- User request: (concise high-level request)\n  - Status: (one sentence)\n"
                        "- User request: first\n  - Status: done\n- User request: second\n", encoding="utf-8")
        self.assertEqual(summary_sources.timeline(file), [("first", "done"), ("second", None)])
        self.assertEqual(summary_sources.timeline(self.dir / "none.md"), [])


class TheCall(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.dir = Path(tempfile.mkdtemp(prefix="josh360-call-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(str(self.dir), True))

    def fake_claude(self, body, code=0):
        script = self.dir / "claude"
        script.write_text("#!/usr/bin/env python3\nimport json, os, sys\n"
                          "open({!r}, 'w').write(json.dumps({{'argv': sys.argv[1:], 'stdin': sys.stdin.read(), "
                          "'flag': os.environ.get('JOSH360_INTERNAL_CALL'), 'cwd': os.getcwd()}}))\n"
                          "print({!r})\nsys.exit({})\n".format(str(self.dir / "seen.json"), body, code),
                          encoding="utf-8")
        script.chmod(script.stat().st_mode | stat.S_IEXEC)
        return str(script)

    def test_the_tier_comes_from_tiers_yaml(self):
        self.assertEqual(summary.cheap_models(), [("claude-haiku-5-5", "high"), ("claude-sonnet-5-5", "medium")])

    def test_the_real_call_has_no_tools_no_session_and_the_internal_flag(self):
        body = json.dumps({"result": "Asked: x", "is_error": False, "total_cost_usd": 0.01,
                           "usage": {"input_tokens": 10, "cache_read_input_tokens": 5,
                                     "cache_creation_input_tokens": 1, "output_tokens": 7}})
        call = summary.claude_caller(self.fake_claude(body), summary.cheap_models(), self.dir / "work")
        result = call("the prompt", 1)
        self.assertEqual((result.text, result.model, result.input_tokens, result.output_tokens, result.cost_usd),
                         ("Asked: x", "claude-sonnet-5-5", 16, 7, 0.01))
        seen = json.loads((self.dir / "seen.json").read_text(encoding="utf-8"))
        argv = seen["argv"]
        self.assertEqual((seen["stdin"], seen["flag"], Path(seen["cwd"]).name), ("the prompt", "1", "work"))
        for flag in ("-p", "--no-session-persistence", "--tools"):
            self.assertIn(flag, argv)
        self.assertEqual(argv[argv.index("--tools") + 1], "")
        self.assertEqual(argv[argv.index("--model") + 1], "claude-sonnet-5-5")
        self.assertEqual(argv[argv.index("--effort") + 1], "medium")

    def test_a_failed_call_is_none(self):
        models = summary.cheap_models()
        for body, code in (("not json", 0), (json.dumps({"result": "x", "is_error": True}), 0),
                           (json.dumps({"result": "x"}), 1), (json.dumps({"no": "result"}), 0)):
            self.assertIsNone(summary.claude_caller(self.fake_claude(body, code), models, self.dir / "w")("p", 0))
        self.assertIsNone(summary.claude_caller(str(self.dir / "missing"), models, self.dir / "w")("p", 0))

    def test_a_call_josh_360_makes_is_not_recorded_as_a_session(self):
        folder = self.dir / "spool"
        payload = json.dumps({"session_id": "sess-0001", "cwd": "/tmp/made-up"})
        for flag, expected in (("1", 0), (None, 1)):
            os.environ.pop("JOSH360_INTERNAL_CALL", None)
            if flag:
                os.environ["JOSH360_INTERNAL_CALL"] = flag
            self.addCleanup(os.environ.pop, "JOSH360_INTERNAL_CALL", None)
            home = self.dir / "home{}".format(flag)
            os.environ["JOSH360_HOME"] = str(home)
            self.addCleanup(os.environ.pop, "JOSH360_HOME", None)
            import io
            spool.main("SessionStart", io.StringIO(payload))
            files = list((home / "state" / "ledger-spool").glob("*.jsonl")) if (home / "state").exists() else []
            self.assertEqual(len(files), expected)
        del folder

    def test_the_summary_makes_no_network_connection_of_its_own(self):
        source = (ROOT / "ledger" / "summary.py").read_text(encoding="utf-8")
        for banned in ("urllib", "http.client", "anthropic", "socket"):
            self.assertNotIn("import " + banned, source)
            self.assertNotIn("from " + banned, source)


if __name__ == "__main__":
    unittest.main()
