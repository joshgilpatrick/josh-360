"""JP-186: the stand-in `claude` on its own, with no Agent Manager: the model probe, the hooks it fires and the
scenarios it plays. Made-up prompts, made-up hooks, temporary HOME; nothing here calls a model."""
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
E2E = ROOT / "tests" / "e2e"
STANDIN = E2E / "standin" / "claude"
KINDS = {"example", "wrong-shape", "silent", "hang", "question", "follow-ups"}

# A hook that appends its event and stdin to $HOOK_LOG, and exits with $BLOCK_<EVENT> when that is set.
RECORDING_HOOK = """#!/usr/bin/env python3
import json, os, sys
payload = json.loads(sys.stdin.read())
event = payload["hook_event_name"]
with open(os.environ["HOOK_LOG"], "a") as f:
    f.write(json.dumps({"who": sys.argv[1], "event": event, "payload": payload,
                        "from_env": os.environ.get("FROM_SETTINGS_ENV")}) + "\\n")
code = os.environ.get("BLOCK_" + event.upper())
if code and sys.argv[1] == "user":
    sys.stderr.write("blocked by a made-up rail\\n")
    sys.exit(int(code))
"""


class StandIn(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="josh360-standin-"))
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.home = self.tmp / "home"
        (self.home / ".claude").mkdir(parents=True)
        self.work = self.tmp / "work"
        self.work.mkdir()
        self.hook = self.tmp / "hook.py"
        self.hook.write_text(RECORDING_HOOK)
        self.hook.chmod(0o755)
        self.hook_log = self.tmp / "hooks.jsonl"
        self.result = self.work / "result.json"
        events = ("SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop",
                  "SessionEnd")
        self.write_settings(self.home / ".claude" / "settings.json", "user", events)
        self.am_settings = self.tmp / "am.settings.json"
        self.write_settings(self.am_settings, "am", events, env={"FROM_SETTINGS_ENV": "yes"}, matcher="*")
        self.env = {k: v for k, v in os.environ.items() if not k.startswith(("JOSH360_", "AGENT_MANAGER_"))}
        self.env.update(HOME=str(self.home), HOOK_LOG=str(self.hook_log), JOSH360_STANDIN_LOG=str(self.tmp / "log"),
                        JOSH360_STANDIN_PLAN=str(self.tmp / "plan.json"), JOSH360_STANDIN_THINK="0")

    def write_settings(self, path, who, events, env=None, matcher=None):
        group = {"hooks": [{"type": "command", "command": "{} {}".format(self.hook, who)}]}
        if matcher:
            group["matcher"] = matcher
        doc = {"hooks": {e: [group] for e in events}}
        if env:
            doc["env"] = env
        path.write_text(json.dumps(doc))

    def plan(self, default="example", **steps):
        (self.tmp / "plan.json").write_text(json.dumps({"default": default, "steps": steps}))

    def prompt(self, step="design", outcomes="ready, needs_input", role=None):
        lines = ["[josh360-step run=r-0a1b2c3d step={} attempt=1 key=0123456789abcdef]".format(step),
                 'Do not run agent-manager rename; this session\'s name "JP-901 - Design" is final.']
        if role:
            lines.append("Read {}/instructions.md first.".format(role))
        lines += ["End with one of these outcomes: {}.".format(outcomes),
                  'When you are done, use the Write tool to write {{"outcome": "<one of them>", "outputs": {{...}}}} '
                  "to {}, then stop.".format(self.result)]
        # Agent Manager puts its own note first, as it does on the laptop
        return "This session is already named. Do not rename it now. Then do the task:\n\n" + "\n".join(lines)

    def play(self, prompt, extra=(), timeout=60):
        argv = [str(STANDIN), "-p", "--model", "opus", "--effort", "high", prompt, "--session-id", "sess-0001",
                "--settings", str(self.am_settings)] + list(extra)
        return subprocess.run(argv, cwd=str(self.work), env=self.env, stdin=subprocess.DEVNULL,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=timeout)

    def hooks(self, who=None):
        if not self.hook_log.is_file():
            return []
        rows = [json.loads(line) for line in self.hook_log.read_text().splitlines()]
        return [r for r in rows if who is None or r["who"] == who]

    def events(self, who="user"):
        return [r["event"] for r in self.hooks(who)]

    def log(self, kind):
        path = self.tmp / "log"
        rows = [json.loads(line) for line in path.read_text().splitlines()] if path.is_file() else []
        return [r for r in rows if r["kind"] == kind]

    # -- the model probe ------------------------------------------------------------------------------------------
    def test_probe_answers_initialize_with_the_laptops_models(self):
        request = {"type": "control_request", "request_id": "catalog", "request": {"subtype": "initialize"}}
        done = subprocess.run([str(STANDIN), "-p", "--input-format", "stream-json", "--output-format", "stream-json",
                               "--verbose", "--safe-mode", "--no-session-persistence"], input=json.dumps(request) + "\n",
                              env=self.env, stdout=subprocess.PIPE, universal_newlines=True, timeout=30)
        reply = json.loads(done.stdout.splitlines()[0])
        self.assertEqual(reply["type"], "control_response")
        self.assertEqual(reply["response"]["subtype"], "success")
        self.assertEqual(reply["response"]["request_id"], "catalog")
        names = [m["value"] for m in reply["response"]["response"]["models"]]
        self.assertEqual(names, ["default", "opus", "fable", "sonnet", "haiku"])
        self.assertEqual(self.hooks(), [])                    # a probe fires no hooks

    def test_the_laptop_list_matches_what_the_binding_says_agent_manager_accepts(self):
        accepts = json.loads((ROOT / "graphs" / "bindings" / "agent-manager" / "binding.json").read_text())["accepts"]
        doc = json.loads((E2E / "laptop-models.json").read_text())
        self.assertEqual([m["value"] for m in doc["models"]], accepts["models"])
        for model in doc["models"]:
            self.assertEqual(model["supportedEffortLevels"], accepts["efforts"], model["value"])

    def test_version(self):
        done = subprocess.run([str(STANDIN), "--version"], env=self.env, stdout=subprocess.PIPE,
                              universal_newlines=True, timeout=30)
        self.assertTrue(done.stdout.startswith("2.1.329"))

    # -- a session ------------------------------------------------------------------------------------------------
    def test_fires_claude_codes_hooks_in_order_from_both_settings_files(self):
        self.plan("example")
        done = self.play(self.prompt())
        self.assertEqual(done.returncode, 0, done.stderr)
        order = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"]
        self.assertEqual(self.events("user"), order)
        self.assertEqual(self.events("am"), order)
        by_event = {r["event"]: r["payload"] for r in self.hooks("user")}
        self.assertEqual(by_event["SessionStart"]["source"], "startup")
        self.assertIn("[josh360-step run=r-0a1b2c3d step=design", by_event["UserPromptSubmit"]["prompt"])
        self.assertEqual(by_event["PreToolUse"]["tool_name"], "Write")
        self.assertEqual(by_event["PreToolUse"]["tool_input"]["file_path"], str(self.result))
        self.assertEqual(by_event["PostToolUse"]["tool_response"]["filePath"], str(self.result))
        self.assertFalse(by_event["Stop"]["stop_hook_active"])
        for payload in by_event.values():
            self.assertEqual(payload["session_id"], "sess-0001")
            self.assertEqual(payload["cwd"], str(self.work))
            self.assertTrue(payload["transcript_path"].endswith("sess-0001.jsonl"))
        self.assertEqual({r["from_env"] for r in self.hooks()}, {"yes"})   # the settings' env reaches every hook
        self.assertEqual(json.loads(self.result.read_text()), {"outcome": "ready", "outputs": {}})
        self.assertTrue(Path(by_event["Stop"]["transcript_path"]).is_file())

    def test_a_blocked_write_writes_nothing(self):
        self.env["BLOCK_PRETOOLUSE"] = "2"
        self.play(self.prompt())
        self.assertFalse(self.result.exists())
        self.assertEqual(self.log("write-blocked")[0]["reason"], "blocked by a made-up rail")
        self.assertNotIn("PostToolUse", self.events("user"))
        self.assertIn("Stop", self.events("user"))

    def test_a_blocked_prompt_ends_the_turn(self):
        self.env["BLOCK_USERPROMPTSUBMIT"] = "2"
        self.play(self.prompt())
        self.assertFalse(self.result.exists())
        self.assertEqual(self.events("user"), ["SessionStart", "UserPromptSubmit", "SessionEnd"])

    def test_a_blocked_stop_runs_again_with_stop_hook_active(self):
        self.env["BLOCK_STOP"] = "2"
        self.plan("silent")
        self.play(self.prompt())
        stops = [r["payload"]["stop_hook_active"] for r in self.hooks("user") if r["event"] == "Stop"]
        self.assertEqual(stops, [False, True, True])
        self.assertFalse(self.result.exists())

    def test_a_scenario_that_obeys_the_stop_nudge_writes_its_result(self):
        self.env["BLOCK_STOP"] = "2"
        self.plan("silent-then-obeys")
        self.play(self.prompt())
        self.assertEqual(json.loads(self.result.read_text())["outcome"], "ready")

    def test_a_json_block_decision_counts_as_blocking(self):
        hook = self.tmp / "deny.sh"
        hook.write_text('#!/bin/sh\ncat >/dev/null\necho \'{"hookSpecificOutput": {"hookEventName": "PreToolUse", '
                        '"permissionDecision": "deny", "permissionDecisionReason": "no"}}\'\n')
        hook.chmod(0o755)
        self.am_settings.write_text(json.dumps({"hooks": {"PreToolUse": [{"matcher": "Write", "hooks": [
            {"type": "command", "command": str(hook)}]}]}}))
        self.play(self.prompt())
        self.assertFalse(self.result.exists())
        self.assertEqual(self.log("write-blocked")[0]["reason"], "no")

    def test_matchers_pick_the_tool(self):
        self.am_settings.write_text(json.dumps({"hooks": {"PreToolUse": [{"matcher": "Bash|Edit", "hooks": [
            {"type": "command", "command": "{} am".format(self.hook)}]}]}}))
        self.play(self.prompt())
        self.assertEqual(self.events("am"), [])
        self.assertTrue(self.result.exists())

    # -- scenarios ------------------------------------------------------------------------------------------------
    def test_every_scenario_file_names_a_known_kind_and_says_what_it_does(self):
        files = sorted((E2E / "scenarios").glob("*.json"))
        self.assertTrue(files)
        found = set()
        for path in files:
            doc = json.loads(path.read_text())
            self.assertIn(doc["kind"], KINDS, path.name)
            self.assertTrue(doc.get("_about"), path.name)
            found.add(doc["kind"])
        self.assertEqual(found, KINDS)

    def test_example_takes_the_roles_example_result(self):
        role = self.tmp / "roles" / "designer"
        role.mkdir(parents=True)
        example = {"outcome": "needs_input", "outputs": {"spec_path": "docs/sample-spec.md"}}
        (role / "instructions.md").write_text("Made-up role.\n\n```json\n{}\n```\n".format(json.dumps(example)))
        self.play(self.prompt(role=role))
        self.assertEqual(json.loads(self.result.read_text()), example)

    def test_a_scenario_can_name_its_own_outcome_and_outputs_per_step(self):
        custom = self.tmp / "custom.json"
        custom.write_text(json.dumps({"kind": "example", "outcome": "needs_input", "outputs": {"why": "made up"}}))
        self.plan("silent", design=str(custom))
        self.play(self.prompt(step="design"))
        self.assertEqual(json.loads(self.result.read_text()), {"outcome": "needs_input", "outputs": {"why": "made up"}})
        self.result.unlink()
        self.play(self.prompt(step="build"))
        self.assertFalse(self.result.exists())

    def test_wrong_shape(self):
        self.plan("wrong-shape")
        self.play(self.prompt())
        doc = json.loads(self.result.read_text())
        self.assertNotIn("outcome", doc)
        self.assertNotIn("outputs", doc)

    def test_silent_writes_nothing_and_stops(self):
        self.plan("silent")
        self.play(self.prompt())
        self.assertFalse(self.result.exists())
        self.assertEqual(self.events("user")[-2:], ["Stop", "SessionEnd"])

    def test_follow_ups_ride_in_the_result(self):
        self.plan("follow-ups")
        self.play(self.prompt())
        doc = json.loads(self.result.read_text())
        self.assertEqual(doc["outcome"], "ready")
        self.assertEqual(len(doc["follow_ups"]), 2)
        self.assertEqual({tuple(sorted(f)) for f in doc["follow_ups"]}, {("blocks", "summary", "why")})

    def test_a_long_prompt_reads_its_task_file(self):
        task = self.tmp / "prompts" / "design-1.md"
        task.parent.mkdir()
        task.write_text("\n".join(self.prompt().splitlines()[4:]) + "\n")
        short = "\n".join(self.prompt().splitlines()[:4] + [
            "Read {} in full before anything else; it is your task.".format(task)])
        self.play(short)
        self.assertEqual(json.loads(self.result.read_text())["outcome"], "ready")

    def background(self, scenario):
        self.plan(scenario)
        argv = [str(STANDIN), "--model", "opus", "--effort", "high", self.prompt(), "--session-id", "sess-0002",
                "--settings", str(self.am_settings)]
        proc = subprocess.Popen(argv, cwd=str(self.work), env=self.env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, universal_newlines=True)
        def finish():
            if proc.poll() is None:
                proc.kill()
            proc.communicate(timeout=15)            # closes the pipes
        self.addCleanup(finish)
        return proc

    def wait_for(self, check, timeout=15):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if check():
                return True
            time.sleep(0.1)
        return False

    def test_hang_never_stops_and_ends_on_sighup(self):
        proc = self.background("hang")
        self.assertTrue(self.wait_for(lambda: self.log("hanging")))
        time.sleep(1)
        self.assertNotIn("Stop", self.events("user"))
        proc.send_signal(signal.SIGHUP)
        proc.wait(timeout=15)
        self.assertEqual(self.events("user")[-1], "SessionEnd")
        self.assertFalse(self.result.exists())

    def test_question_asks_and_waits_at_the_dialog(self):
        proc = self.background("question")
        self.assertTrue(self.wait_for(lambda: self.log("asking")))
        pre = [r["payload"] for r in self.hooks("user") if r["event"] == "PreToolUse"]
        self.assertEqual(pre[0]["tool_name"], "AskUserQuestion")
        note = [r["payload"] for r in self.hooks("am") if r["event"] == "Notification"]
        self.assertEqual(note[0]["notification_type"], "elicitation_dialog")
        self.assertNotIn("Stop", self.events("user"))
        proc.terminate()
        proc.wait(timeout=15)
        self.assertFalse(self.result.exists())

    def test_a_typed_line_at_rest_is_a_new_turn(self):
        proc = self.background("example")
        self.assertTrue(self.wait_for(lambda: self.events("user").count("Stop") == 1))
        proc.stdin.write("A made-up message from a lead\n")
        proc.stdin.flush()
        self.assertTrue(self.wait_for(lambda: self.events("user").count("Stop") == 2))
        prompts = [r["payload"]["prompt"] for r in self.hooks("user") if r["event"] == "UserPromptSubmit"]
        self.assertEqual(prompts[-1], "A made-up message from a lead")
        proc.terminate()
        proc.wait(timeout=15)

    def test_the_stand_in_parses_as_python_39(self):
        import ast
        for path in (STANDIN, E2E / "am-record", E2E / "agent_manager.py"):
            ast.parse(path.read_text(), filename=str(path), feature_version=(3, 9))


if __name__ == "__main__":
    unittest.main()
