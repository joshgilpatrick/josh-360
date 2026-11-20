"""JP-182: list every hook block from the stored transcripts. Each @auto scenario from the ticket is a test here, on a
made-up laptop (hook_blocks_helpers.py); nothing real is read."""
import datetime
import json
import os
import types
import unittest
from pathlib import Path

import hook_blocks_helpers as h  # noqa: I001  (first: it puts scripts/ on the path)
from hook_blocks_lib import attribute, follow, transcripts
from doctor_lib import hook_checks

GUARD = "rm is not allowed here, use trash instead"
DENY = "reading secrets is not allowed in this folder"
STOP = "run the tests before you stop"
PROMPT = "this prompt names a production database"


class EveryKind(h.HookBlocksCase):
    def setUp(self):
        super().setUp()
        self.guard = self.script("guard.py", 'MSG = "{}"\nimport sys; sys.exit(2)'.format(GUARD))
        self.secrets = self.script("secrets.py", 'REASON = "{}"'.format(DENY))
        self.stop = self.script("stop.py", 'print("{}")'.format(STOP))
        self.prompt = self.script("prompt.py", 'REASON = "{}"'.format(PROMPT))
        self.user_settings(h.settings(
            dict(event="PreToolUse", matcher="Bash", command=self.guard),
            dict(event="PreToolUse", matcher="Read", command=self.secrets),
            dict(event="Stop", command=self.stop),
            dict(event="UserPromptSubmit", command=self.prompt)))
        s = h.Session()
        s.prompt("tidy the build folder")
        s.pre_block("Bash", {"command": "rm -rf build"}, GUARD)
        s.text("The hook stopped that. Should I move it to the trash instead?")
        s.prompt("yes, and read the env file")
        s.pre_block("Read", {"file_path": "/made/up/project/.env"}, DENY, label=None)
        s.text("I can't read that file.")
        s.stop_block(STOP)
        s.bash("make test")
        s.text("Tests pass.")
        s.prompt_block("look at the production database", PROMPT, label="command hook")
        s.write(self.projects)

    def test_every_kind_of_block_is_listed_with_every_field(self):
        """Scenario: Every kind of block in a transcript is listed."""
        code, out, md, data = self.run_cli()
        self.assertEqual(code, 0, out)
        kinds = sorted((b["event"], b["tool"] or "") for b in data["blocks"])
        self.assertEqual(kinds, [("PreToolUse", "Bash"), ("PreToolUse", "Read"), ("Stop", ""), ("UserPromptSubmit", "")])
        for b in data["blocks"]:
            for key in ("ts", "session", "folder", "event", "hook", "attempted", "message", "next"):
                self.assertTrue(b[key], (key, b))
            self.assertNotEqual(b["found_by"], "unknown", b)
            self.assertIn(b["message"], md)
        by_event = {(b["event"], b["tool"]): b for b in data["blocks"]}
        self.assertEqual(by_event[("PreToolUse", "Bash")]["hook"], "user:guard.py")
        self.assertEqual(by_event[("PreToolUse", "Bash")]["attempted"], "rm -rf build")
        self.assertEqual(by_event[("PreToolUse", "Bash")]["next"], "asked-josh")
        self.assertEqual(by_event[("PreToolUse", "Read")]["hook"], "user:secrets.py")
        self.assertEqual(by_event[("PreToolUse", "Read")]["next"], "gave-up")
        self.assertEqual(by_event[("Stop", None)]["next"], "continued")
        self.assertEqual(by_event[("UserPromptSubmit", None)]["attempted"], "look at the production database")
        self.assertEqual(by_event[("UserPromptSubmit", None)]["hook"], "user:prompt.py")
        for field in ("Event and tool: PreToolUse / Bash", "folder `/made/up/project`", "session `sess-0001`",
                      "Attempted: `rm -rf build`", "Next: asked-josh"):
            self.assertIn(field, md)
        self.assertIn("4 blocks by 4 hooks", md)

    def test_a_stop_block_is_counted_once(self):
        """The attachment and the stop summary describe one block."""
        _, _, _, data = self.run_cli()
        self.assertEqual(len([b for b in data["blocks"] if b["event"] == "Stop"]), 1)

    def test_the_read_only_block_is_a_likely_false_alarm_and_rm_is_not(self):
        _, _, _, data = self.run_cli()
        by_tool = {b["tool"]: b for b in data["blocks"] if b["event"] == "PreToolUse"}
        self.assertEqual(by_tool["Read"]["false_alarm"], "the blocked call changes nothing")
        self.assertIsNone(by_tool["Bash"]["false_alarm"])


class Reworded(h.HookBlocksCase):
    def test_a_reworded_retry_that_succeeds_is_a_likely_false_alarm(self):
        """Scenario: A reworded retry that succeeds is flagged as a likely false alarm."""
        guard = self.script("worktree-guard.py", 'MSG = "removing a worktree needs a check first"')
        self.user_settings(h.settings(dict(event="PreToolUse", matcher="Bash", command=guard)))
        s = h.Session()
        s.prompt("clean up")
        s.pre_block("Bash", {"command": "git worktree remove ../wt-feature --force"},
                    "removing a worktree needs a check first")
        s.bash("cd .. && git worktree remove wt-feature --force", "done")
        s.write(self.projects)
        _, out, md, data = self.run_cli()
        (b,) = data["blocks"]
        self.assertEqual(b["next"], "other-way-succeeded")
        self.assertEqual(b["false_alarm"], "done straight after another way")
        row = self.row(data, "user:worktree-guard.py")
        self.assertEqual((row["blocks"], row["false_alarms"]), (1, 1))
        self.assertIn("| user:worktree-guard.py | user | PreToolUse | `Bash` | 1 | 1 |", md)
        self.assertIn("user:worktree-guard.py: 1 blocks, 1 likely false alarms", out)

    def test_the_same_call_again_is_retried_and_a_failed_reword_is_not_a_false_alarm(self):
        guard = self.script("g.py", 'MSG = "no deploys from here"')
        self.user_settings(h.settings(dict(event="PreToolUse", matcher="Bash", command=guard)))
        s = h.Session()
        s.prompt("deploy")
        s.pre_block("Bash", {"command": "make deploy target=prod"}, "no deploys from here")
        s.pre_block("Bash", {"command": "make deploy target=prod"}, "no deploys from here")
        tid = s.call("Bash", {"command": "make deploy target=prod now"})
        s.result(tid, "Error: make failed", error=True)
        s.write(self.projects)
        _, _, _, data = self.run_cli()
        self.assertEqual([b["next"] for b in data["blocks"]], ["retried", "other-way-failed"])
        self.assertEqual([b["false_alarm"] for b in data["blocks"]], [None, None])

    def test_a_read_with_another_tool_counts_as_the_same_job(self):
        s = h.Session()
        s.prompt("show the config")
        s.pre_block("Bash", {"command": "cat /made/up/project/config.yaml > /tmp/x"}, "no redirects")
        tid = s.call("Read", {"file_path": "/made/up/project/config.yaml"})
        s.result(tid, "key: value")
        s.write(self.projects)
        _, _, _, data = self.run_cli()
        self.assertEqual(data["blocks"][0]["next"], "other-way-succeeded")


class NeverBlocked(h.HookBlocksCase):
    def test_hooks_that_never_blocked_still_appear(self):
        """Scenario: Hooks that never blocked still appear."""
        a = self.script("a.py", 'MSG = "hook a says no to this command"')
        b = self.script("b.py", 'MSG = "hook b says no"')
        c = self.script("c.py", 'MSG = "hook c says no"')
        self.user_settings(h.settings(dict(event="PreToolUse", matcher="Bash", command=a),
                                      dict(event="PreToolUse", matcher="Bash", command=b),
                                      dict(event="Stop", command="python3 " + c)))
        s = h.Session()
        s.prompt("go")
        s.pre_block("Bash", {"command": "rm x"}, "hook a says no to this command", label="command hook 1")
        s.write(self.projects)
        _, _, md, data = self.run_cli()
        counts = {i: self.row(data, i)["blocks"] for i in ("user:a.py", "user:b.py", "user:c.py")}
        self.assertEqual(counts, {"user:a.py": 1, "user:b.py": 0, "user:c.py": 0})
        self.assertIn("| user:c.py | user | Stop | all | 0 | 0 |", md)

    def test_every_source_is_listed(self):
        """Project settings, enabled plugins, settings passed with --settings and josh-360 files."""
        folder = self.tmp / "proj"
        (folder / ".claude").mkdir(parents=True)
        (folder / ".claude" / "settings.json").write_text(json.dumps(h.settings(
            dict(event="PreToolUse", matcher="Edit", command="$CLAUDE_PROJECT_DIR/.claude/hooks/edit-guard.sh"))))
        plugin = self.claude / "plugins" / "cache" / "mkt" / "tidy" / "1.0.0"
        (plugin / "hooks").mkdir(parents=True)
        (plugin / "hooks" / "hooks.json").write_text(json.dumps(h.settings(
            dict(event="Stop", command="${CLAUDE_PLUGIN_ROOT}/hooks/stop.sh"))))
        off = self.claude / "plugins" / "cache" / "mkt" / "off" / "1.0.0"
        (off / "hooks").mkdir(parents=True)
        (off / "hooks" / "hooks.json").write_text(json.dumps(h.settings(dict(event="Stop", command="x"))))
        (self.claude / "plugins" / "installed_plugins.json").write_text(json.dumps({"version": 2, "plugins": {
            "tidy@mkt": [{"scope": "user", "installPath": str(plugin)}],
            "off@mkt": [{"scope": "user", "installPath": str(off)}]}}))
        extra = self.tmp / "guardrails.json"
        extra.write_text(json.dumps(h.settings(dict(event="PreToolUse", matcher="Bash|Write",
                                                    command="npx tsx /made/up/guardrailsHook.ts"))))
        dispatch = 'f="$HOME/.josh-360/repo/hooks/dispatch"; [ -x "$f" ] || exit 0; exec "$f" PreToolUse'
        data = h.settings(dict(event="PreToolUse", matcher="*", command=dispatch))
        data["enabledPlugins"] = {"off@mkt": False, "tidy@mkt": True}
        self.user_settings(data)
        self.josh360_hook("PreToolUse", "10-guard")
        self.josh360_hook("Stop", "20-stop")
        s = h.Session(folder=str(folder))
        s.prompt("hi")
        s.write(self.projects)
        _, _, _, data = self.run_cli("--settings-file", str(extra))
        ids = {r["id"]: r for r in data["hooks"]}
        self.assertEqual(ids["project proj:edit-guard.sh"]["scope"], [str(folder)])
        self.assertIn("plugin tidy:stop.sh", ids)
        self.assertNotIn("plugin off:x", ids)
        self.assertIn("extra guardrails:guardrailsHook.ts", ids)
        self.assertEqual(ids["josh-360:PreToolUse/10-guard"]["note"], "")
        self.assertIn("no dispatcher entry", ids["josh-360:Stop/20-stop"]["note"])
        self.assertFalse([i for i in ids if "dispatch" in i], "the dispatcher entry is replaced by its files")


class Unreadable(h.HookBlocksCase):
    def test_an_unreadable_transcript_is_skipped_and_named(self):
        """Scenario: An unreadable transcript is not read as "no blocks"."""
        s = h.Session(sid="good")
        s.prompt("go")
        s.pre_block("Bash", {"command": "rm a"}, "no rm")
        s.write(self.projects)
        bad = self.projects / "made-up-project" / "broken.jsonl"
        bad.write_text("{this is not json\nneither is this\n")
        binary = self.projects / "made-up-project" / "binary.jsonl"
        binary.write_bytes(b"\xff\xfe\x00garbage")
        partly = h.Session(sid="partly")
        partly.prompt("go")
        path = partly.write(self.projects)
        path.write_text(path.read_text() + '{"truncated": \n')
        code, out, md, data = self.run_cli()
        self.assertEqual(code, 0)
        skipped = {Path(s["path"]).name for s in data["transcripts"]["skipped"]}
        self.assertEqual(skipped, {"broken.jsonl", "binary.jsonl"})
        self.assertEqual([Path(p["path"]).name for p in data["transcripts"]["partly"]], ["partly.jsonl"])
        self.assertIn("broken.jsonl`: skipped, no line is JSON", md)
        self.assertIn("binary.jsonl`: skipped, cannot be read", md)
        self.assertEqual(len(data["blocks"]), 1)
        self.assertIn("2 skipped", out)


class StaysOnTheLaptop(h.HookBlocksCase):
    def test_it_writes_only_under_josh360_home_and_calls_nothing(self):
        """Scenario: The review stays on the laptop."""
        s = h.Session()
        s.prompt("go")
        s.pre_block("Bash", {"command": "rm a"}, "no rm")
        s.write(self.projects)
        before = {p for p in self.tmp.rglob("*")}
        code, _, _, _ = self.run_cli()
        self.assertEqual(code, 0)
        new = {p for p in self.tmp.rglob("*")} - before
        self.assertTrue(new)
        for p in new:
            self.assertTrue(str(p).startswith(str(self.j360) + os.sep), p)
        md = self.j360 / "reviews" / "hook-blocks" / "hook-blocks-2026-11-20.md"
        self.assertEqual(md.stat().st_mode & 0o777, 0o600)
        self.assertIn("stays on this laptop", md.read_text())

    def test_an_out_dir_outside_josh360_home_is_refused(self):
        code, _, _, _ = self.run_cli("--out-dir", str(self.tmp / "elsewhere"))
        self.assertEqual(code, 2)
        self.assertFalse((self.tmp / "elsewhere").exists())

    def test_the_code_has_no_way_to_send_anything(self):
        """No network, no subprocess, no git: so nothing reaches GitHub, Jira or the laptop-status branch."""
        files = [h.REPO / "scripts" / "hook_blocks.py"] + sorted((h.REPO / "scripts" / "hook_blocks_lib").glob("*.py"))
        for f in files:
            text = f.read_text()
            for word in ("subprocess", "urllib", "http.client", "socket", "status.py", "requests"):
                self.assertNotIn(word, text, "{} mentions {}".format(f.name, word))


class Attribution(h.HookBlocksCase):
    def test_hooks_log_names_the_josh360_file(self):
        dispatch = 'f="$HOME/.josh-360/repo/hooks/dispatch"; [ -x "$f" ] || exit 0; exec "$f" PreToolUse'
        self.user_settings(h.settings(dict(event="PreToolUse", matcher="*", command=dispatch),
                                      dict(event="PreToolUse", matcher="*", command="node /made/up/remote.js")))
        self.josh360_hook("PreToolUse", "10-atlas-removal-guard")
        self.josh360_hook("PreToolUse", "20-graph-step-guard")
        (self.j360 / "logs" / "hooks.log").write_text(
            "2026-11-19T10:00:01Z PreToolUse 20-graph-step-guard failed (exit 1), skipped\n"
            "2026-11-19T10:00:02Z PreToolUse 10-atlas-removal-guard blocked (exit 2)\n")
        s = h.Session()
        s.prompt("go")
        s.pre_block("Bash", {"command": "git worktree remove ../x"}, "wording found in no source file at all")
        s.write(self.projects)
        _, _, _, data = self.run_cli()
        (b,) = data["blocks"]
        self.assertEqual((b["hook"], b["found_by"]), ("josh-360:PreToolUse/10-atlas-removal-guard", "hooks.log"))

    def test_the_message_is_found_in_a_file_the_script_names(self):
        lib = self.scripts / "lib"
        lib.mkdir()
        (lib / "rules.js").write_text("module.exports = () => 'pushing to main is not allowed from a session'\n")
        entry = self.script("entry.js", "const rules = require('./lib/rules')")
        other = self.script("other.js", "console.log('hello')")
        self.user_settings(h.settings(dict(event="PreToolUse", matcher="Bash", command="node " + entry),
                                      dict(event="PreToolUse", matcher="Bash", command="node " + other)))
        s = h.Session()
        s.prompt("go")
        s.pre_block("Bash", {"command": "git push origin main"}, "pushing to main is not allowed from a session")
        s.write(self.projects)
        _, _, _, data = self.run_cli()
        self.assertEqual((data["blocks"][0]["hook"], data["blocks"][0]["found_by"]), ("user:entry.js", "message text"))

    def test_an_unclaimed_block_is_unknown_with_its_candidates(self):
        self.user_settings(h.settings(dict(event="PreToolUse", matcher="Bash", command="/made/up/one.sh"),
                                      dict(event="PreToolUse", matcher="", command="/made/up/two.sh")))
        s = h.Session()
        s.prompt("go")
        s.pre_block("Bash", {"command": "ls"}, "no")
        s.write(self.projects)
        _, _, md, data = self.run_cli()
        b = data["blocks"][0]
        self.assertEqual((b["hook"], b["found_by"]), ("unknown (PreToolUse)", "unknown"))
        self.assertEqual(sorted(b["candidates"]), ["user:one.sh", "user:two.sh"])
        self.assertIn("candidates: ", md)

    def test_subagent_blocks_and_old_blocks(self):
        s = h.Session(sid="parent", agent="a123")
        s.prompt("sub task")
        s.pre_block("Bash", {"command": "rm a"}, "no rm")
        s.stop_block("finish the report first")
        s.write(self.projects, parent="parent")
        old = h.Session(sid="old")  # a file still in the window, holding a block from before it
        old.prompt("x")
        old.pre_block("Bash", {"command": "rm b"}, "no rm")
        old.entries[-1]["timestamp"] = "2026-10-01T00:00:00.000Z"
        old.write(self.projects)
        _, _, _, data = self.run_cli()
        self.assertEqual(sorted(b["event"] for b in data["blocks"]), ["PreToolUse", "SubagentStop"])
        self.assertTrue(all(b["agent"] == "a123" for b in data["blocks"]))


class Pieces(unittest.TestCase):
    def test_label_and_message_are_split(self):
        self.assertEqual(transcripts.split_label("[command hook 2]: no\n"), ("command hook 2", "no"))
        self.assertEqual(transcripts.split_label("plain reason"), (None, "plain reason"))

    def test_changes_nothing(self):
        reads = ['echo "remove the worktree"', "git log --oneline -5", "ls -la 2>&1 | head", "gh pr view 3",
                 "gh api repos/o/r/contents/x?ref=main", "sed -n 1,5p f", "git worktree list", "cat a | grep b"]
        writes = ["rm -rf build", "git worktree remove ../x", "echo hi > f", "gh api -X DELETE repos/o/r",
                  "git branch -D old", "sed -i s/a/b/ f", "python3 tidy.py", "find . -delete", "echo $(rm x)",
                  "gh pr merge 3", "git push", "git branch new-one"]
        for c in reads:
            self.assertTrue(follow.changes_nothing("Bash", {"command": c}), c)
        for c in writes:
            self.assertFalse(follow.changes_nothing("Bash", {"command": c}), c)
        self.assertTrue(follow.changes_nothing("Grep", {"pattern": "x"}))
        self.assertFalse(follow.changes_nothing("Edit", {"file_path": "x"}))

    def test_epoch_reads_transcript_and_log_times(self):
        self.assertEqual(attribute.epoch("2026-11-19T10:00:02Z") + 0.5, attribute.epoch("2026-11-19T10:00:02.500Z"))
        self.assertIsNone(attribute.epoch("yesterday"))


class DoctorCountsBlocks(unittest.TestCase):
    def ctx(self, log_text):
        import tempfile
        folder = Path(tempfile.mkdtemp(prefix="josh360-doctor-log-"))
        (folder / "hooks.log").write_text(log_text)
        return types.SimpleNamespace(logs=folder, now=datetime.datetime(2026, 11, 20, 12, 0, tzinfo=datetime.timezone.utc),
                                     tilde=str)

    def test_a_block_in_the_last_day_is_named_with_its_count(self):
        """Scenario: Doctor counts blocks."""
        r = hook_checks.hooks_log(self.ctx(
            "2026-11-20T09:00:00Z PreToolUse 10-atlas-removal-guard blocked (exit 2)\n"
            "2026-11-20T10:00:00Z PreToolUse 10-atlas-removal-guard blocked (exit 2)\n"
            "2026-11-18T10:00:00Z Stop 20-graph-step-stop blocked (exit 2)\n"))
        self.assertEqual(r.status, "pass")
        self.assertIn("hooks that blocked in the last 24 hours: 10-atlas-removal-guard x2", r.detail)
        self.assertNotIn("20-graph-step-stop", r.detail)

    def test_a_failure_warns_and_names_the_hook_not_the_word_failed(self):
        r = hook_checks.hooks_log(self.ctx(
            "2026-11-20T09:00:00Z PreToolUse 30-ticket-offer failed (exit 1), skipped\n"
            "2026-11-20T09:01:00Z Stop 20-graph-step-stop blocked (exit 2)\n"))
        self.assertEqual(r.status, "warn")
        self.assertIn("hooks that failed in the last 24 hours: 30-ticket-offer x1", r.detail)
        self.assertIn("hooks that blocked in the last 24 hours: 20-graph-step-stop x1", r.detail)

    def test_nothing_recent_passes(self):
        r = hook_checks.hooks_log(self.ctx("2026-11-01T09:00:00Z PreToolUse x blocked (exit 2)\n"))
        self.assertEqual((r.status, r.detail), ("pass", "no hook failed or blocked in the last 24 hours"))


if __name__ == "__main__":
    unittest.main()
