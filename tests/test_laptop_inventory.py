"""Tests for the JP-96 laptop script, on a made-up home folder. No real transcripts are used.

Run: python3 -m unittest discover -s tests -v
"""
from __future__ import annotations

import hashlib
import json
import os
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import laptop_figures  # noqa: E402
import laptop_inventory  # noqa: E402

CANARY = "CANARY patient Jane Example DOB 1970-01-01 said the secret word"


def jl(path: Path, entries: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(e) for e in entries) + "\n", encoding="utf-8")


def user(ts: str, content, **extra) -> dict:
    return {"type": "user", "timestamp": ts, "message": {"role": "user", "content": content}, **extra}


def assistant(ts: str, blocks: list[dict]) -> dict:
    return {"type": "assistant", "timestamp": ts, "message": {"role": "assistant", "content": blocks}}


def git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True,
                   env=dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.com",
                            GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.com"))


def make_home(base: Path) -> Path:
    home = base / "home"
    projects = home / ".claude/projects/-Users-x-Development-josh-360"
    # Session A (week of 2026-11-02): two of Josh's messages, a JP branch, one Skill and one agent call,
    # plus injected text and a tool result that must not count. The canary must never reach the output.
    jl(projects / "a.jsonl", [
        user("2026-11-03T15:00:00Z", CANARY, gitBranch="JP-96-inventory", entrypoint="cli"),
        assistant("2026-11-03T15:00:05Z", [
            {"type": "text", "text": CANARY},
            {"type": "tool_use", "name": "Skill", "input": {"skill": "superpowers:brainstorming"}},
            {"type": "tool_use", "name": "Agent", "input": {"subagent_type": "Explore", "prompt": CANARY}},
        ]),
        user("2026-11-03T15:00:06Z", [{"type": "tool_result", "content": CANARY}]),
        user("2026-11-03T15:01:00Z", "<command-name>/focus</command-name>"),
        user("2026-11-03T15:01:01Z", "<system-reminder>x</system-reminder>"),
        user("2026-11-03T15:02:00Z", [{"type": "text", "text": "second message"}]),
        user("2026-11-03T15:03:00Z", "meta", isMeta=True),
    ])
    # Session B (week of 2026-11-09): headless, ticket named only in Josh's message.
    jl(projects / "b.jsonl", [
        user("2026-11-10T09:00:00Z", "Work AD-12 please", gitBranch="main", entrypoint="sdk-cli"),
        "not json at all",
    ])
    (projects / "b.jsonl").write_text((projects / "b.jsonl").read_text() + "{broken\n")
    # Session C: outside the date range, no ticket.
    jl(projects / "c.jsonl", [user("2026-08-01T09:00:00Z", "old", gitBranch="main")])
    os.utime(projects / "c.jsonl", (1_754_000_000, 1_754_000_000))
    # A subagent transcript: not a session, but its skill use counts.
    jl(projects / "a/subagents/agent-1.jsonl", [
        assistant("2026-11-03T15:00:10Z", [{"type": "tool_use", "name": "Skill", "input": {"skill": "pdf"}}]),
    ])

    claude = home / ".claude"
    (claude / "settings.json").write_text(json.dumps({
        "hooks": {"Stop": [{"matcher": "", "hooks": [
            {"type": "command", "command": f"python3 ~/.claude/hooks/stage.py --token SECRETVALUE '{CANARY}'"}]}]},
        "enabledPlugins": {"claude-mem@thedotmack": True, "old@x": False},
        "mcpServers": {"context-mode": {"command": "npx", "env": {"KEY": "SECRETVALUE"}}},
    }))
    for name in ("focus", "brainstorming", "never-used"):
        (claude / "skills" / name).mkdir(parents=True)
        (claude / "skills" / name / "SKILL.md").write_text(CANARY)
    (claude / "agents").mkdir()
    (claude / "agents/reviewer.md").write_text(CANARY)
    (claude / "atlas").mkdir()
    (claude / "atlas/atlas.db").write_bytes(b"x" * 2048)
    (home / ".claude-mem").mkdir()
    (home / ".claude-mem/claude-mem.db").write_bytes(b"y" * 100)

    agents_dir = home / "Library/LaunchAgents"
    agents_dir.mkdir(parents=True)
    with (agents_dir / "com.example.job.plist").open("wb") as fh:
        plistlib.dump({"Label": "com.example.job", "ProgramArguments": ["/usr/bin/python3",
                       str(home / "jobs/run.py"), "--password", "SECRETVALUE"],
                       "StartInterval": 3600, "RunAtLoad": True,
                       "StandardOutPath": str(base / "job.log")}, fh)
    (base / "job.log").write_text(CANARY)

    repo = home / "Development/sample-repo"
    repo.mkdir(parents=True)
    git(repo, "init", "-q", "-b", "main")
    git(repo, "commit", "-q", "--allow-empty", "-m", "one")
    git(repo, "branch", "JP-1-no-remote")
    git(repo, "branch", "JP-2-also-local")
    git(repo, "worktree", "add", "-q", str(home / "Development/sample-repo/.claude/worktrees/w1"), "-b", "wt")
    return home


def snapshot(base: Path) -> dict[str, tuple]:
    """Every path under base with its size, mtime and content hash."""
    snap = {}
    for root, dirs, names in os.walk(base):
        for n in names + dirs:
            p = Path(root) / n
            st = os.lstat(p)
            digest = hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() and not p.is_symlink() else ""
            snap[str(p.relative_to(base))] = (st.st_size if p.is_file() else 0, st.st_mtime_ns if p.is_file() else 0, digest)
    return snap


class LaptopInventoryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        cls.home = make_home(cls.tmp)
        cls.before = snapshot(cls.tmp)
        cls.out = cls.tmp / "out/inventory.json"
        cls.out.parent.mkdir()
        cls.before = snapshot(cls.tmp)
        cls.code = laptop_inventory.main([
            "--out", str(cls.out), "--home", str(cls.home),
            "--since", "2026-11-02", "--until", "2026-11-15", "--usage-days", "36500",
        ])
        cls.after = snapshot(cls.tmp)
        cls.text = cls.out.read_text(encoding="utf-8") if cls.out.exists() else ""
        cls.report = json.loads(cls.text) if cls.text else {}

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    # Scenario: The laptop step only reads
    def test_writes_nothing_but_its_output_file(self):
        self.assertEqual(self.code, 0)
        added = set(self.after) - set(self.before)
        changed = {k for k in self.before if k in self.after and self.before[k] != self.after[k]}
        removed = set(self.before) - set(self.after)
        self.assertEqual(added, {"out/inventory.json"})
        self.assertEqual(changed, set(), f"changed: {changed}")
        self.assertEqual(removed, set())

    def test_output_holds_no_file_contents(self):
        for leak in ("CANARY", "Jane", "SECRETVALUE", "secret word", "second message", "Work AD-12"):
            self.assertNotIn(leak, self.text)
        self.assertEqual(laptop_inventory.check_output(self.report), [])

    def test_refuses_to_overwrite(self):
        self.assertEqual(laptop_inventory.main(["--out", str(self.out), "--home", str(self.home)]), 2)

    def test_guard_refuses_text(self):
        self.assertTrue(laptop_inventory.check_output({"a": "line one\nline two"}))
        self.assertTrue(laptop_inventory.check_output({"a": "x" * 400}))
        self.assertTrue(laptop_inventory.check_output({"a": 'said "hello"; then?'}))
        self.assertEqual(laptop_inventory.check_output({"a": "~/Library/Application Support/x.db", "n": 3}), [])
        self.assertEqual(laptop_inventory.scrub({"ok": "fine", "bad\nkey": "a\nb"}),
                         {"ok": "fine", "(unlisted 1)": "(unlisted)"})

    def test_only_read_only_commands(self):
        allowed = {("launchctl", "list"), ("brew", "services", "list"), ("ps", "-axo", "comm="),
                   ("crontab", "-l"), ("lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-F", "cn")}
        self.assertEqual({tuple(v) for v in laptop_inventory.READ_ONLY_COMMANDS.values()}, allowed)
        self.assertEqual(laptop_figures.READ_ONLY_GIT, ("for-each-ref", "worktree", "symbolic-ref", "rev-list"))
        with self.assertRaises(ValueError):
            laptop_figures._git(self.home, "checkout", "main")

    # Scenario: Starting figures can be reproduced (the numbers the figures file quotes)
    def test_session_figures(self):
        f = self.report["figures"]
        self.assertEqual(f["date_range"], {"from": "2026-11-02", "to": "2026-11-15"})
        self.assertEqual(f["sessions"], 2)
        self.assertEqual([w["sessions"] for w in f["sessions_per_week"]], [1, 1])
        self.assertEqual(f["josh_messages_per_session"]["max"], 2)
        self.assertEqual(f["josh_messages_by_entrypoint"]["cli"]["sessions"], 1)
        self.assertEqual(f["tied_to_ticket"]["by_branch"], 1)
        self.assertEqual(f["tied_to_ticket"]["by_branch_or_message"], 2)
        self.assertEqual(f["unreadable_lines"], 1)  # "{broken"; a bare JSON string is skipped, not counted
        self.assertEqual(f["skill_use"]["superpowers:brainstorming"]["uses"], 1)
        self.assertEqual(f["skill_use"]["focus"]["last_used"], "2026-11-03")
        self.assertEqual(f["skill_use"]["pdf"]["uses"], 1)
        self.assertEqual(f["agent_use"]["Explore"]["uses"], 1)

    def test_loose_ends(self):
        le = self.report["loose_ends"]
        self.assertEqual(le["repos_found"], 1)
        repo = le["repos"][0]
        self.assertEqual(repo["path"], "~/Development/sample-repo")
        self.assertEqual(repo["branches_without_remote"], 3)  # two JP branches and the worktree's branch
        self.assertEqual(repo["extra_worktrees"], 1)
        self.assertEqual(le["local_loose_ends"], 4)

    def test_lists_jobs_hooks_plugins_and_stores(self):
        plist = self.report["launchd_plists"][0]
        self.assertEqual(plist["label"], "com.example.job")
        self.assertEqual(plist["start_interval_seconds"], 3600)
        self.assertEqual(plist["scripts"], ["~/jobs/run.py"])
        self.assertTrue(plist["StandardOutPath"]["exists"])
        settings = self.report["claude_settings"][".claude/settings.json"]
        self.assertEqual(settings["hooks"][0]["event"], "Stop")
        self.assertEqual(settings["hooks"][0]["scripts"], ["~/.claude/hooks/stage.py"])
        self.assertEqual(settings["enabled_plugins"], ["claude-mem@thedotmack"])
        self.assertEqual(settings["mcp_servers"], ["context-mode"])
        self.assertEqual(sorted(self.report["definitions"][".claude/skills"]), ["brainstorming", "focus", "never-used"])
        self.assertIn("reviewer", self.report["definitions"][".claude/agents"])
        known = self.report["stores"]["known"]
        self.assertEqual(known["~/.claude/atlas"]["bytes"], 2048)
        self.assertFalse(known["~/.claude/context-mode"]["exists"])
        self.assertIn("~/.claude-mem/claude-mem.db", self.report["stores"]["sqlite_files"])

    def test_runs_on_python_39_syntax(self):
        # macOS ships Python 3.9: no match statements or runtime X | Y unions in these two files.
        for name in ("laptop_inventory.py", "laptop_figures.py"):
            src = (ROOT / "scripts" / name).read_text(encoding="utf-8")
            self.assertIn("from __future__ import annotations", src)
            self.assertNotRegex(src, r"^\s*match .*:$")

    def test_default_range_is_twelve_whole_weeks(self):
        since, until = laptop_inventory.default_range(date(2026, 11, 18))
        self.assertEqual((since.isoformat(), until.isoformat()), ("2026-08-24", "2026-11-15"))


if __name__ == "__main__":
    unittest.main()
