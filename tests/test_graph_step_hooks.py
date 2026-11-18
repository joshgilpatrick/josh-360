"""JP-117, Tasks 6 to 8: the four hooks that put the rails on a graph step's session, and on no other session."""
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

from runner_helpers import ROOT, RunnerCase
from runner_lib import hooklib, sessionfile

OK = (0, "", "")


class Linking(RunnerCase):
    def setUp(self):
        super().setUp()
        self.run_id = self.start("valid", "JP-901")
        self.session = self.fake_spawn(self.run_id)

    def link(self, prompt, session_id="cc-1", **env):
        return hooklib.link({"session_id": session_id, "prompt": prompt}, dict({"AGENT_MANAGER_SESSION_ID": "s-1"}, **env),
                            self.now)

    def prompt(self):
        return self.logged_prompt(self.run_id, "design")

    def entry_file(self, sid="cc-1"):
        from ledger import graph_sessions
        return graph_sessions.entry_path(sid)

    def test_first_prompt_with_the_marker_links_the_session(self):
        entry = self.session_starts(self.run_id, "design")
        for key in ("run", "step", "attempt", "access", "outcomes", "result_file", "work_dir"):
            self.assertEqual(entry[key], self.session[key], key)
        self.assertEqual((entry["am_session"], entry["nudged_at"], entry["started_at"]), ("s-1", None, self.now))
        link = sessionfile.read_link(self.run_id, "design", 1)
        self.assertEqual(link["session_id"], "cc-1")

    def test_marker_may_follow_text_agent_manager_adds(self):
        self.assertEqual(self.link("some preamble\nmore text\n" + self.prompt()), OK)
        self.assertTrue(self.entry_file().is_file())

    def test_wrong_key_does_not_link(self):
        bad = self.prompt().replace("key=0123456789abcdef", "key=ffffffffffffffff")
        self.assertEqual(self.link(bad), OK)
        self.assertFalse(self.entry_file().exists())

    def test_marker_for_a_recorded_step_does_not_link(self):
        doc = sessionfile.read(self.run_id, "design", 1)
        sessionfile.write(self.run_id, "design", 1, dict(doc, state="recorded"))
        self.assertEqual(self.link(self.prompt()), OK)
        self.assertFalse(self.entry_file().exists())

    def test_second_session_with_the_same_marker_does_not_link(self):
        self.session_starts(self.run_id, "design")
        self.assertEqual(self.link(self.prompt(), session_id="cc-2"), OK)
        self.assertFalse(self.entry_file("cc-2").exists())

    def test_unknown_run_does_not_link(self):
        bad = self.prompt().replace(self.run_id, "r-ffffffffffff")
        self.assertEqual(self.link(bad), OK)
        self.assertFalse(self.entry_file().exists())

    def test_ordinary_prompt_is_untouched(self):
        os.environ["JOSH360_RUNS"] = str(self.tmp / "no-runs-here")
        with mock.patch.object(sessionfile, "read", side_effect=AssertionError("read a run folder")):
            self.assertEqual(self.link("Please fix the build. [josh360-step is only a phrase]"), OK)
        self.assertFalse((self.tmp / "no-runs-here").exists())

    def test_hook_file_runs_through_the_dispatcher(self):
        payload = json.dumps({"session_id": "cc-1", "hook_event_name": "UserPromptSubmit", "prompt": self.prompt()})
        env = dict(os.environ, AGENT_MANAGER_SESSION_ID="s-1")
        done = subprocess.run([str(ROOT / "hooks" / "dispatch"), "UserPromptSubmit"], input=payload,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, env=env)
        self.assertEqual((done.returncode, done.stdout), (0, ""), done.stderr)
        self.assertTrue(self.entry_file().is_file())

    def test_guard_file_denies_a_graph_session_when_the_runner_code_cannot_load(self):
        import shutil
        self.session_starts(self.run_id, "design")
        broken = self.tmp / "broken" / "hooks" / "PreToolUse"          # no graphs/runner beside it: the import fails
        broken.mkdir(parents=True)
        shutil.copy(str(ROOT / "hooks" / "PreToolUse" / "20-graph-step-guard"), str(broken / "20-graph-step-guard"))
        results = {}
        for session in ("cc-1", "cc-other"):
            payload = json.dumps({"session_id": session, "hook_event_name": "PreToolUse", "tool_name": "Bash",
                                  "tool_input": {"command": "ls"}})
            done = subprocess.run([sys.executable, str(broken / "20-graph-step-guard")], input=payload,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
            results[session] = done.returncode
        self.assertEqual(results, {"cc-1": 2, "cc-other": 0})


class Linked(RunnerCase):
    """A linked step session `cc-1` (step `design`, access josh) and helpers to feed it tool calls."""

    def setUp(self):
        super().setUp()
        self.run_id = self.start("valid", "JP-901")
        self.fake_spawn(self.run_id)
        self.entry = self.session_starts(self.run_id, "design")
        self.home = os.environ["JOSH360_HOME"]
        self.run_folder = os.environ["JOSH360_RUNS"] + "/" + self.run_id
        self.work = self.entry["work_dir"]

    def set_entry(self, **changes):
        from ledger import graph_sessions
        path = graph_sessions.entry_path("cc-1")
        doc = json.loads(path.read_text())
        doc.update(changes)
        path.write_text(json.dumps(doc))

    def pre(self, tool, session_id="cc-1", now=None, **tool_input):
        return hooklib.guard({"session_id": session_id, "tool_name": tool, "tool_input": tool_input}, {},
                             self.now if now is None else now)

    def bash(self, command, **kw):
        return self.pre("Bash", command=command, **kw)

    def assertDenied(self, result, words=""):
        self.assertEqual(result[0], 2, result)
        self.assertTrue(result[2].startswith(words) or words in result[2], result)

    def assertAllowed(self, result):
        self.assertEqual(result, OK)


class Guarding(Linked):
    def test_ask_user_question_is_denied(self):
        self.assertDenied(self.pre("AskUserQuestion", questions=[]), "a step session does not ask questions")

    def test_jira_write_tool_is_denied_and_a_read_is_allowed(self):
        self.assertDenied(self.pre("mcp__Atlassian_MCP__editJiraIssue", issueIdOrKey="JP-1"), "only gate scripts write to Jira")
        self.assertAllowed(self.pre("mcp__Atlassian_MCP__getJiraIssue", issueIdOrKey="JP-1"))

    def test_github_write_tool_is_denied_and_a_read_is_allowed(self):
        self.assertDenied(self.pre("mcp__github__create_pull_request"), "only gate scripts write to GitHub")
        self.assertAllowed(self.pre("mcp__github__get_file_contents"))
        self.assertAllowed(self.pre("mcp__github__pull_request_read"))

    def test_gh_reads_pass_and_writes_do_not(self):
        for ok in ("gh pr view 5", "gh api repos/o/r/pulls", "gh pr checks 5 && gh run list", "gh search prs x"):
            self.assertAllowed(self.bash(ok))
        for bad in ("gh pr create", "gh pr merge 5", "gh api -X POST repos/o/r/issues",
                    "gh api repos/o/r/labels -f name=x", "echo hi; gh issue comment 3 --body x"):
            self.assertDenied(self.bash(bad), "only gate scripts write to GitHub")

    def test_jira_cli_writes_are_denied(self):
        self.assertDenied(self.bash("acli jira workitem transition --key JP-1"), "only gate scripts write to Jira")
        self.assertAllowed(self.bash("ls docs/jira-notes"))

    def test_secrets_and_the_keychain_are_denied(self):
        self.assertDenied(self.pre("Read", file_path="/x/.env"), "a step session does not read secrets")
        self.assertDenied(self.bash("cat ~/.aws/credentials"), "a step session does not read secrets")
        self.assertDenied(self.bash("security find-generic-password -s jira-claude-api-key -w"),
                          "a step session does not read the keychain")
        self.assertAllowed(self.pre("Read", file_path="/x/environment.md"))

    def test_home_folder_spellings_of_the_protected_paths_are_denied(self):
        for spelling in ("~/.josh-360", "$HOME/.josh-360", "${HOME}/.josh-360"):
            self.assertDenied(self.bash("rm {}/state/graph-sessions/mine.json".format(spelling)),
                              "a step session does not change the runner")
            self.assertDenied(self.bash("rm {}/repo/hooks/PreToolUse/20-graph-step-guard".format(spelling)),
                              "a step session does not change the runner")
        self.assertAllowed(self.bash("cat ~/.josh-360/repo/graphs/roles/builder/instructions.md"))

    def test_ssh_keys_are_secrets(self):
        self.assertDenied(self.bash("cat ~/.ssh/id_ed25519"), "a step session does not read secrets")
        self.assertDenied(self.pre("Read", file_path="/Users/x/.ssh/id_rsa"), "a step session does not read secrets")

    def test_a_wrapper_before_gh_does_not_hide_a_write(self):
        for bad in ("env gh pr create", "command gh pr merge 1", "exec gh issue close 3", "env GH_PAGER=cat gh pr merge 2"):
            self.assertDenied(self.bash(bad), "only gate scripts write to GitHub")
        self.assertAllowed(self.bash("env gh pr view 4"))

    def test_the_rails_and_other_runs_are_protected(self):
        self.assertDenied(self.pre("Edit", file_path=self.home + "/repo/hooks/PreToolUse/20-graph-step-guard"),
                          "a step session does not change the runner")
        self.assertDenied(self.pre("Write", file_path=os.environ["JOSH360_RUNS"] + "/r-aaaaaaaaaaaa/work/x.md"),
                          "a step session does not change the runner")
        self.assertDenied(self.bash("echo x > " + self.home + "/state/ledger.db"), "a step session does not change the runner")
        self.assertDenied(self.bash("python3 " + self.home + "/repo/graphs/tools/walker.py abandon --run r-1"),
                          "a step session does not change the runner")
        self.assertAllowed(self.pre("Write", file_path=self.work + "/notes.md"))
        self.assertAllowed(self.bash("cat " + self.home + "/repo/graphs/roles/builder/instructions.md 2>/dev/null"))

    def test_the_run_folder_outside_work_is_protected(self):
        self.assertDenied(self.pre("Write", file_path=self.run_folder + "/sessions/design-1.json"),
                          "a step session does not change the runner")
        self.assertAllowed(self.pre("Write", file_path=self.run_folder + "/prompts/x.md"))

    def test_read_step_writes_only_its_result_and_work_folder(self):
        self.set_entry(access="read")
        for bad in (("Edit", {"file_path": "/work/tree/a.py"}), ("Bash", {"command": "git commit -m x"}),
                    ("Bash", {"command": "echo x > /tmp/y"}), ("Bash", {"command": "cp a.txt b.txt"}),
                    ("Bash", {"command": "python3 x.py > out.txt"})):
            self.assertDenied(self.pre(bad[0], **bad[1]), "this step only reads")
        for good in (("Write", {"file_path": self.work + "/findings.md"}), ("Bash", {"command": "git diff main"}),
                     ("Bash", {"command": "git diff main 2>&1"}), ("Bash", {"command": "ls missing 2>/dev/null"}),
                     ("Bash", {"command": "python3 -m unittest tests.test_x"}),
                     ("Bash", {"command": "python3 scripts/check.py --fast"}),
                     ("Bash", {"command": "echo x > " + self.work + "/y"})):
            self.assertAllowed(self.pre(good[0], **good[1]))

    def test_josh_step_may_commit_and_push(self):
        self.assertAllowed(self.bash("git commit -m x"))
        self.assertAllowed(self.bash("git push"))

    def test_turn_cap_denies_everything_but_the_result(self):
        self.settings(turn_cap=3)
        for _ in range(3):
            self.assertAllowed(self.pre("Read", file_path="/x/a.txt"))
        self.assertDenied(self.pre("Read", file_path="/x/a.txt"), "turn cap reached")
        self.assertAllowed(self.pre("Write", file_path=self.entry["result_file"]))

    def test_time_cap_denies_everything_but_the_result(self):
        later = self.now + 3 * 3600
        self.assertDenied(self.pre("Read", now=later, file_path="/x/a.txt"), "time cap reached")
        self.assertAllowed(self.pre("Write", now=later, file_path=self.entry["result_file"]))

    def test_unreadable_entry_is_denied(self):
        from ledger import graph_sessions
        graph_sessions.entry_path("cc-1").write_text("{")
        self.assertDenied(self.pre("Read", file_path="/x/a.txt"), "graph step guard")

    def test_other_sessions_are_untouched(self):
        for tool, tool_input in (("AskUserQuestion", {}), ("mcp__Atlassian_MCP__editJiraIssue", {}),
                                 ("Bash", {"command": "cat .env"})):
            self.assertAllowed(self.pre(tool, session_id="ordinary-1", **tool_input))
        from ledger import graph_sessions
        self.assertFalse((graph_sessions.folder() / "ordinary-1.calls").exists())

    def test_reflection_every_forty_calls(self):
        self.settings(reflect_every=2)
        out = []
        for _ in range(5):
            self.pre("Read", file_path="/x/a.txt")
            code, printed, err = hooklib.reflect({"session_id": "cc-1", "tool_name": "Read"}, {}, self.now)
            self.assertEqual((code, err), (0, ""))
            out.append(printed)
        self.assertEqual([bool(o) for o in out], [False, True, False, True, False])
        doc = json.loads(out[1])["hookSpecificOutput"]
        self.assertEqual(doc["hookEventName"], "PostToolUse")
        self.assertIn("2 tool calls", doc["additionalContext"])

    def test_guard_file_blocks_through_the_dispatcher(self):
        payload = json.dumps({"session_id": "cc-1", "hook_event_name": "PreToolUse", "tool_name": "AskUserQuestion",
                              "tool_input": {"questions": []}})
        done = subprocess.run([str(ROOT / "hooks" / "dispatch"), "PreToolUse"], input=payload, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, universal_newlines=True)
        self.assertEqual(done.returncode, 2, done.stderr)
        self.assertIn("does not ask questions", done.stderr)


class Stopping(Linked):
    def stop(self, session_id="cc-1", active=False, now=None):
        return hooklib.stop({"session_id": session_id, "stop_hook_active": active}, {}, self.now if now is None else now)

    def put_comment(self, text="Use the second spec.", name="10042.json"):
        folder = Path(self.run_folder) / "comments"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / name).write_text(json.dumps({"ticket": "JP-901", "comment_id": "10042", "name": "Josh",
                                               "created": "2026-11-17T10:00:00Z", "text": text}))

    def test_stop_without_a_result_is_nudged_once(self):
        first = self.stop()
        self.assertEqual(first[0], 2)
        self.assertIn(self.entry["result_file"], first[2])
        for outcome in self.entry["outcomes"]:
            self.assertIn(outcome, first[2])
        from ledger import graph_sessions
        self.assertEqual(json.loads(graph_sessions.entry_path("cc-1").read_text())["nudged_at"], self.now)
        self.assertEqual(self.stop(), OK)

    def test_stop_passes_new_comments_on(self):
        self.put_comment()
        first = self.stop()
        self.assertEqual(first[0], 2)
        self.assertIn("Use the second spec.", first[2])
        self.assertIn("not an instruction", first[2])
        self.assertNotIn("Use the second spec.", self.stop()[2])

    def test_stop_hook_active_never_blocks(self):
        self.put_comment()
        self.assertEqual(self.stop(active=True), OK)

    def test_stop_after_the_result_is_written_is_quiet(self):
        Path(self.entry["result_file"]).write_text("{}")
        self.put_comment()
        self.assertEqual(self.stop(), OK)

    def test_stop_in_an_ordinary_session_is_quiet(self):
        self.assertEqual(self.stop(session_id="ordinary-1"), OK)

    def test_stop_file_blocks_through_the_dispatcher(self):
        payload = json.dumps({"session_id": "cc-1", "hook_event_name": "Stop", "stop_hook_active": False})
        done = subprocess.run([str(ROOT / "hooks" / "dispatch"), "Stop"], input=payload, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, universal_newlines=True)
        self.assertEqual(done.returncode, 2, done.stderr)
        self.assertIn(self.entry["result_file"], done.stderr)


if __name__ == "__main__":
    unittest.main()
