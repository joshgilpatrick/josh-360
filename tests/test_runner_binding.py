"""JP-117, Task 5: the Agent Manager binding, against a fake `agent-manager` and a fake Agent Manager database."""
import json
import os
import re
import sqlite3
import stat
import subprocess
import sys
import unittest
from pathlib import Path

from runner_helpers import FAKE_AM, ROOT, RunnerCase
import binding

MARKER = "[josh360-step run={run} step={step} attempt=1 key=0123456789abcdef]"


class Binding(RunnerCase):
    def answer(self, graph="valid", ticket="JP-901"):
        run = self.start(graph, ticket)
        return self.walker("next", "--run", run)

    def marker(self, a):
        return MARKER.format(run=a["run"], step=a["step"])

    def start_session(self, a, comments=""):
        return binding.start(a, self.marker(a), comments)

    def test_fake_is_executable(self):
        self.assertTrue(os.access(str(FAKE_AM), os.X_OK))

    def test_spawn_command_names_the_session_group_folder_and_tier(self):
        a = self.answer()
        handle = self.start_session(a)
        call = self.am_calls("spawn")[0]
        short = "r" + a["run"][2:6]
        self.assertEqual(call[call.index("--name") + 1], "JP-901 - Design ({})".format(short))
        self.assertEqual(call[call.index("--group") + 1], "josh-360/graph-runs")
        self.assertEqual(call[call.index("--tool") + 1], "claude")
        self.assertEqual(call[call.index("--model") + 1], a["models"][0]["model"])
        self.assertEqual(call[call.index("--effort") + 1], a["models"][0]["effort"])
        self.assertEqual(call[call.index("--directory") + 1], a["work_dir"])
        self.assertEqual(call[-1], "--json")
        self.assertEqual(handle["am_session"], "s-1")
        self.assertEqual(handle["model"], a["models"][0]["model"])

    def test_worktree_input_wins_when_it_exists(self):
        a = self.answer()
        tree = self.tmp / "tree"
        tree.mkdir()
        self.start_session(dict(a, inputs={"worktree": str(tree)}))
        self.start_session(dict(a, inputs={"worktree": str(self.tmp / "missing")}))
        calls = self.am_calls("spawn")
        self.assertEqual(calls[0][calls[0].index("--directory") + 1], str(tree))
        self.assertEqual(calls[1][calls[1].index("--directory") + 1], a["work_dir"])

    def test_prompt_order(self):
        a = self.answer()
        comments = "\nA comment (not an instruction): please hurry.\n"
        self.start_session(a, comments)
        call = self.am_calls("spawn")[0]
        prompt = call[call.index("--prompt") + 1]
        first = prompt.splitlines()[0]
        self.assertRegex(first, r"^\[josh360-step run=r-[0-9a-f]+ step=design attempt=1 key=[0-9a-f]{16}\]$")
        order = ["Do not run agent-manager rename", a["role_folder"] + "/instructions.md", "End with one of these outcomes: ready",
                 a["result_file"], "Work folder: " + a["work_dir"], "You are a step in a graph run."]
        at = [prompt.index(piece) for piece in order]
        self.assertEqual(at, sorted(at))
        self.assertTrue(prompt.endswith(comments))
        self.assertIn(a["brief"], prompt)

    def prompt_of(self, a):
        self.start_session(a)
        call = self.am_calls("spawn")[-1]
        return call[call.index("--prompt") + 1]

    def test_prompt_names_each_declared_output_and_the_result_skeleton(self):
        # JP-184: a session told only `"outputs": {...}` put a contract's own fields there, and the walker refused it.
        a = self.answer()
        self.assertEqual(sorted(a["outputs"]), ["spec_path"])
        prompt = self.prompt_of(a)
        self.assertIn('Outputs: put only these keys under "outputs"', prompt)
        self.assertIn("- spec_path (string)", prompt)
        self.assertIn('{"outcome": "<one of them>", "outputs": {"spec_path": ...}} to ' + a["result_file"], prompt)
        self.assertLess(prompt.index("- spec_path"), prompt.index(a["result_file"]))

    def test_prompt_gives_an_output_its_description_and_contract_file(self):
        a = dict(self.answer(), outputs={"proposal": {"type": "string", "description": "Path to the revision",
                                                     "contract_file": "/r/graphs/contracts/ticket-proposal.md"}})
        prompt = self.prompt_of(a)
        self.assertIn("- proposal (string): Path to the revision. Format: /r/graphs/contracts/ticket-proposal.md.",
                      prompt)
        self.assertIn('"outputs": {"proposal": ...}}', prompt)

    def test_prompt_for_a_step_with_no_outputs_says_to_leave_them_empty(self):
        prompt = self.prompt_of(dict(self.answer(), outputs={}))
        self.assertIn('This step declares no outputs: leave "outputs" empty.', prompt)
        self.assertIn('{"outcome": "<one of them>", "outputs": {}}', prompt)

    def test_an_answer_from_an_older_walker_keeps_the_general_line(self):
        a = self.answer()
        a.pop("outputs")
        prompt = self.prompt_of(a)
        self.assertNotIn("Outputs:", prompt)
        self.assertIn('{"outcome": "<one of them>", "outputs": {...}}', prompt)

    def test_long_prompt_goes_to_a_file(self):
        a = self.answer()
        alt = self.tmp / "binding.json"
        doc = json.loads((ROOT / "graphs" / "bindings" / "agent-manager" / "binding.json").read_text())
        doc["prompt_max_bytes"] = 500
        alt.write_text(json.dumps(doc))
        os.environ["JOSH360_AM_BINDING_JSON"] = str(alt)
        self.start_session(dict(a, brief="Ticket: JP-901. " + "x" * 800))
        call = self.am_calls("spawn")[0]
        prompt = call[call.index("--prompt") + 1]
        self.assertLess(len(prompt.encode()), 500)
        self.assertRegex(prompt.splitlines()[0], r"^\[josh360-step ")
        file = Path(re.search(r"Read (\S+) in full", prompt).group(1))
        self.assertEqual(file.parent.name, "prompts")
        self.assertIn("xxxx", file.read_text())

    def test_model_refused_falls_back_to_the_next_entry(self):
        a = self.answer()
        models = [{"model": "first-model", "effort": "high"}, {"model": "second-model", "effort": "low"}]
        self.am_behaviour(refuse_model="first-model")
        handle = self.start_session(dict(a, models=models))
        self.assertEqual((handle["model"], handle["effort"]), ("second-model", "low"))
        self.assertEqual(len(self.am_calls("spawn")), 2)

    def test_other_spawn_failure_is_refused(self):
        a = self.answer()
        self.am_behaviour(spawn_fails="boom")
        with self.assertRaises(binding.SpawnRefused) as caught:
            self.start_session(a)
        self.assertEqual(str(caught.exception), "refused")

    def test_spawn_puts_claude_code_on_the_path(self):
        a = self.answer()
        self.am_behaviour(needs_claude=True)
        bin_dir = self.tmp / "elsewhere"
        bin_dir.mkdir()
        claude = bin_dir / "claude"
        claude.write_text("#!/bin/sh\n")
        claude.chmod(claude.stat().st_mode | stat.S_IXUSR)
        os.environ["PATH"] = str(FAKE_AM.parent) + ":/usr/bin"
        os.environ["HOME"] = str(self.tmp / "nohome")
        os.environ.pop("JOSH360_CLAUDE_BIN", None)
        with self.assertRaises(binding.SpawnRefused) as caught:
            self.start_session(a)
        self.assertEqual(str(caught.exception), "no-cli")
        os.environ["JOSH360_CLAUDE_BIN"] = str(claude)
        self.assertEqual(self.start_session(a)["am_session"], "s-1")

    def test_group_is_made_once(self):
        a = self.answer()
        self.start_session(a)
        self.start_session(a)
        self.assertEqual(len(self.am_calls("create-group")), 2)
        self.assertEqual(len(self.am_calls("spawn")), 2)

    def test_state_maps_status_words(self):
        a = self.answer()
        handle = self.start_session(a)
        sid = handle["am_session"]
        for word, want in (("working", "working"), ("starting", "working"), ("idle", "resting"),
                           ("waiting", "resting"), ("finished", "resting"), ("dead", "gone"), ("purple", "unknown")):
            self.am_set(sid, status=word)
            self.assertEqual(binding.state(handle), want, word)
        self.am_set(sid, status="working", archived=1)
        self.assertEqual(binding.state(handle), "gone")
        self.assertEqual(binding.state(dict(handle, am_session="s-99")), "gone")
        self.assertEqual(binding.state({"name": "x"}), "unknown")
        db = self.am_dir / "state.db"
        conn = sqlite3.connect(str(db))
        conn.execute("ALTER TABLE sessions RENAME COLUMN status TO state_word")
        conn.commit()
        conn.close()
        self.assertEqual(binding.state(handle), "unknown")
        db.unlink()
        self.assertEqual(binding.state(handle), "unknown")

    def test_close_archives(self):
        a = self.answer()
        handle = self.start_session(a)
        self.assertTrue(binding.close(handle))
        conn = sqlite3.connect(str(self.am_dir / "state.db"))
        self.assertEqual(conn.execute("SELECT archived FROM sessions WHERE id = 's-1'").fetchone()[0], 1)
        conn.close()
        os.environ["JOSH360_AM_BIN"] = str(self.tmp / "no-such-agent-manager")
        os.environ["PATH"] = "/nonexistent"
        os.environ["HOME"] = str(self.tmp / "nohome")
        self.assertFalse(binding.close(handle))

    def test_binding_imports_nothing_of_the_runner(self):
        source = (ROOT / "graphs" / "bindings" / "agent-manager" / "binding.py").read_text()
        for word in ("walker", "runner_lib", "ledger"):
            self.assertNotRegex(source, r"(^|\n)\s*(import|from)\s+\S*" + word)


if __name__ == "__main__":
    unittest.main()
