#!/usr/bin/env python3
"""The real Agent Manager for cloud tests (JP-186). Python 3.9, standard library only.

The product runs only through Agent Manager on Josh's laptop. A cloud session or CI job uses this to run the same
Agent Manager, at the laptop's version, with no screen, against a stand-in `claude` (`tests/e2e/standin/claude`), so
the binding is tested against the real thing without calling a model:

    agent_manager.py install                 build the pinned version once (go install), into the cache folder
    agent_manager.py up    --root DIR        make an instance in DIR and start its manager; prints its environment
    agent_manager.py check --root DIR        is it installed, and is the manager running? (exit 1 when not)
    agent_manager.py env   --root DIR        print the instance's environment as JSON
    agent_manager.py down  --root DIR        stop the manager and every session pane

An instance is one folder: `home/` is HOME, `home/.config` is XDG_CONFIG_HOME (so Agent Manager's database is
`home/.config/agent-manager/state.db`, which `JOSH360_AM_DB` names), `tmux/` is TMUX_TMPDIR (so its tmux servers are
its own), and `am-calls.jsonl` logs every call the binding makes (through `am-record`). Statuses only move in the
database while a manager runs: `up` starts one in a detached tmux session.

Every subcommand prints JSON. Exit 0 on success, 1 when a check fails, 2 for bad input.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from typing import Dict, Iterable, List, Optional

HERE = Path(__file__).resolve().parent
STANDIN = HERE / "standin"
RECORDER = HERE / "am-record"
PINNED = "0.47.1"                        # Josh's laptop, 20 November 2026 (cloud-e2e-testing-design.md)
MODULE = "github.com/YoanWai/agent-manager"
TMUX_MIN = (3, 1)
MANAGER_SESSION = "josh360-am-manager"   # the detached tmux session the manager runs in
MANAGER_SOCKET = "josh360-e2e"           # its own tmux server, apart from Agent Manager's `agentmgr` server
AM_SOCKET = "agentmgr"
POLL_INTERVAL = "5s"                     # the laptop's config.toml sets only this
SECRET_PREFIXES = ("JOSH360_JIRA_", "ACTION_AGENT_JIRA_", "ACTION_TRIAGE_JIRA", "ATLASSIAN", "GH_", "GITHUB_",
                   "AZURE_", "ANTHROPIC_", "JOSH360_AZ", "CLAUDE_CODE_OAUTH")
NOT_RUNNING = ("the Agent Manager manager is not running, so session statuses stay at 'starting'; "
               "start it with: python3 tests/e2e/agent_manager.py up --root <instance>")


class Problem(Exception):
    """Something the harness needs is missing; the message says what."""


class ManagerNotRunning(Problem):
    pass


# -- installing ------------------------------------------------------------------------------------------------------

def cache_dir() -> Path:
    return Path(os.environ.get("JOSH360_E2E_CACHE") or os.path.join(os.path.expanduser("~"), ".cache", "josh360-e2e"))


def binary(version: str = PINNED) -> Path:
    return cache_dir() / "agent-manager-{}".format(version) / "agent-manager"


def version_of(path: Path) -> Optional[str]:
    try:
        done = subprocess.run([str(path), "--version"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              universal_newlines=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return None
    found = re.search(r"(\d+\.\d+\.\d+)", done.stdout)
    return found.group(1) if done.returncode == 0 and found else None


def installed(version: str = PINNED) -> Optional[Path]:
    """The pinned binary when it is there and says it is that version; else None."""
    path = binary(version)
    return path if path.is_file() and version_of(path) == version else None


def tmux_version() -> Optional[tuple]:
    try:
        done = subprocess.run(["tmux", "-V"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              universal_newlines=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    found = re.search(r"(\d+)\.(\d+)", done.stdout)
    return (int(found.group(1)), int(found.group(2))) if found else None


def missing_tools() -> List[str]:
    problems = []
    found = tmux_version()
    if found is None:
        problems.append("tmux is not installed (Agent Manager needs 3.1 or newer: apt-get install -y tmux)")
    elif found < TMUX_MIN:
        problems.append("tmux {}.{} is older than 3.1".format(*found))
    if not shutil.which("git"):
        problems.append("git is not installed")
    return problems


def install(version: str = PINNED) -> Path:
    """Build the pinned Agent Manager with `go install` unless it is already in the cache folder."""
    done = installed(version)
    if done:
        return done
    problems = missing_tools()
    if not shutil.which("go"):
        problems.append("go is not installed (https://go.dev/dl/)")
    if problems:
        raise Problem("; ".join(problems))
    target = binary(version).parent
    target.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, GOBIN=str(target))
    run = subprocess.run(["go", "install", "{}@v{}".format(MODULE, version)], env=env, stdout=subprocess.PIPE,
                         stderr=subprocess.STDOUT, universal_newlines=True, timeout=900)
    if run.returncode != 0:
        raise Problem("go install failed: " + run.stdout.strip()[-2000:])
    done = installed(version)
    if not done:
        raise Problem("go install finished but {} does not say it is {}".format(binary(version), version))
    return done


# -- an instance -----------------------------------------------------------------------------------------------------

class Instance:
    """One throwaway Agent Manager home with its own tmux servers, driven through the real binary."""

    def __init__(self, root: Path, am_bin: Optional[Path] = None):
        self.root = Path(root).resolve()
        self.am_bin = Path(am_bin) if am_bin else (installed() or binary())
        self.home = self.root / "home"
        self.config_home = self.home / ".config"
        self.tmux_dir = self.root / "tmux"
        self.calls_log = self.root / "am-calls.jsonl"
        self.standin_log = self.root / "standin.jsonl"
        self.standin_plan = self.root / "standin-plan.json"

    @property
    def db(self) -> Path:
        return self.config_home / "agent-manager" / "state.db"

    @property
    def claude_settings(self) -> Path:
        return self.home / ".claude" / "settings.json"

    def setup(self) -> "Instance":
        for folder in (self.home, self.config_home / "agent-manager", self.tmux_dir, self.home / ".claude"):
            folder.mkdir(parents=True, exist_ok=True)
        config = self.config_home / "agent-manager" / "config.toml"
        if not config.exists():
            config.write_text('poll_interval = "{}"\n'.format(POLL_INTERVAL), encoding="utf-8")
        if not self.claude_settings.exists():
            self.claude_settings.write_text("{}\n", encoding="utf-8")
        return self

    def env(self, base: Optional[Dict[str, str]] = None) -> Dict[str, str]:
        """The environment every Agent Manager call, the manager and the stand-in sessions run with."""
        env = {k: v for k, v in (base if base is not None else os.environ).items()
               if not k.startswith(SECRET_PREFIXES) and k not in ("TMUX", "TMUX_PANE")}
        system = env.get("PATH") or "/usr/local/bin:/usr/bin:/bin"
        env.update({
            "HOME": str(self.home), "XDG_CONFIG_HOME": str(self.config_home), "TMUX_TMPDIR": str(self.tmux_dir),
            "PATH": os.pathsep.join([str(STANDIN), str(self.am_bin.parent), system]),
            "JOSH360_AM_BIN": str(RECORDER), "JOSH360_E2E_REAL_AM": str(self.am_bin),
            "JOSH360_E2E_AM_LOG": str(self.calls_log), "JOSH360_AM_DB": str(self.db),
            "JOSH360_CLAUDE_BIN": str(STANDIN / "claude"), "JOSH360_CLAUDE_SETTINGS": str(self.claude_settings),
            "JOSH360_STANDIN_LOG": str(self.standin_log), "JOSH360_STANDIN_PLAN": str(self.standin_plan)})
        return env

    # -- calls ----------------------------------------------------------------------------------------------------
    def am(self, args: List[str], timeout: int = 120) -> subprocess.CompletedProcess:
        return subprocess.run([str(RECORDER)] + args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, universal_newlines=True, timeout=timeout, env=self.env())

    def tmux(self, socket: str, args: List[str]) -> subprocess.CompletedProcess:
        return subprocess.run(["tmux", "-L", socket] + args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, universal_newlines=True, timeout=30, env=self.env())

    def calls(self, word: Optional[str] = None) -> List[dict]:
        if not self.calls_log.is_file():
            return []
        rows = [json.loads(line) for line in self.calls_log.read_text(encoding="utf-8").splitlines() if line.strip()]
        return [r for r in rows if word is None or (r["argv"] and r["argv"][0] == word)]

    def standin_events(self, kind: Optional[str] = None) -> List[dict]:
        if not self.standin_log.is_file():
            return []
        rows = [json.loads(line) for line in self.standin_log.read_text(encoding="utf-8").splitlines() if line.strip()]
        return [r for r in rows if kind is None or r.get("kind") == kind]

    def plan(self, default: str = "example", steps: Optional[Dict[str, object]] = None) -> None:
        """Which scenario the stand-in plays, by default and per step."""
        self.standin_plan.write_text(json.dumps({"default": default, "steps": steps or {}}), encoding="utf-8")

    def rails(self, repo: Path, events: Iterable[str] = ("SessionStart", "UserPromptSubmit", "PreToolUse",
                                                          "PostToolUse", "Stop", "SessionEnd")) -> None:
        """Claude settings naming the checkout's hooks/dispatch for each event, as the laptop's settings do."""
        dispatch = Path(repo) / "hooks" / "dispatch"
        hooks = {e: [{"hooks": [{"type": "command", "command": "{} {}".format(dispatch, e)}]}] for e in events}
        self.claude_settings.write_text(json.dumps({"hooks": hooks}, indent=1), encoding="utf-8")

    # -- the manager ----------------------------------------------------------------------------------------------
    def snapshot(self) -> Optional[dict]:
        try:
            done = self.am(["snapshot", "--json"], timeout=60)
            return json.loads(done.stdout) if done.returncode == 0 else None
        except (OSError, ValueError, subprocess.SubprocessError):
            return None

    def manager_running(self) -> bool:
        """Agent Manager's own answer: `snapshot --json` says whether a manager is awake on this host."""
        snap = self.snapshot()
        return bool(snap and snap.get("manager_awake"))

    def start_manager(self, timeout: float = 30) -> None:
        if self.manager_running():
            return
        command = "exec {}".format(self.am_bin)
        done = self.tmux(MANAGER_SOCKET, ["new-session", "-d", "-s", MANAGER_SESSION, "-x", "200", "-y", "50",
                                          command])
        if done.returncode != 0 and "duplicate session" not in done.stderr:
            raise Problem("could not start the manager: " + done.stderr.strip())
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.manager_running():
                return
            time.sleep(0.5)
        raise Problem("the manager did not come up within {}s; its screen: {}".format(timeout, self.manager_screen()))

    def manager_screen(self) -> str:
        done = self.tmux(MANAGER_SOCKET, ["capture-pane", "-p", "-t", MANAGER_SESSION])
        return done.stdout.strip()[-1500:] if done.returncode == 0 else "(no screen: {})".format(done.stderr.strip())

    def stop(self) -> None:
        """Stop the manager and every session pane (each stand-in gets SIGHUP and fires SessionEnd)."""
        for socket in (MANAGER_SOCKET, AM_SOCKET):
            try:
                self.tmux(socket, ["kill-server"])
            except (OSError, subprocess.SubprocessError):
                pass

    # -- reading sessions -----------------------------------------------------------------------------------------
    def row(self, session: str) -> Optional[dict]:
        if not self.db.is_file():
            return None
        conn = sqlite3.connect("file:{}?mode=ro".format(self.db), uri=True, timeout=10)
        conn.row_factory = sqlite3.Row
        try:
            found = conn.execute("SELECT * FROM sessions WHERE id = ?", (session,)).fetchone()
        finally:
            conn.close()
        return dict(found) if found else None

    def wait_status(self, session: str, wanted: Iterable[str], timeout: float = 30) -> str:
        """Wait until the session's database status is one of `wanted`. A session stuck at `starting` with no
        manager running raises ManagerNotRunning, because nothing else will ever move it."""
        wanted = set(wanted)
        deadline = time.time() + timeout
        status = None
        while time.time() < deadline:
            row = self.row(session)
            status = row.get("status") if row else None
            if status in wanted:
                return status
            time.sleep(0.25)
        if status == "starting" and not self.manager_running():
            raise ManagerNotRunning(NOT_RUNNING)
        raise Problem("session {} is {!r} after {}s, not one of {}".format(session, status, timeout, sorted(wanted)))

    def check(self) -> dict:
        found = self.am_bin if version_of(self.am_bin) == PINNED else None
        report = {"installed": bool(found), "binary": str(self.am_bin), "version": PINNED,
                  "problems": missing_tools(), "manager_running": False, "db": str(self.db)}
        if not found:
            report["problems"].append("Agent Manager {} is not installed: python3 tests/e2e/agent_manager.py "
                                      "install".format(PINNED))
        else:
            report["manager_running"] = self.manager_running()
            if not report["manager_running"]:
                report["problems"].append(NOT_RUNNING)
        return report


# -- the command line ------------------------------------------------------------------------------------------------

def out(doc: object, code: int = 0) -> int:
    print(json.dumps(doc, indent=2, sort_keys=True))
    return code


def main(argv: List[str]) -> int:
    parser = argparse.ArgumentParser(prog="agent_manager.py", description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("install")
    for name in ("up", "check", "env", "down"):
        sub.add_parser(name).add_argument("--root", required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "install":
            return out({"ok": True, "binary": str(install()), "version": PINNED})
        instance = Instance(Path(args.root))
        if args.command == "up":
            if not installed():
                raise Problem("Agent Manager {} is not installed: run install first".format(PINNED))
            instance.setup().start_manager()
            return out({"ok": True, "manager_running": True, "env": instance.env({})})
        if args.command == "check":
            report = instance.check()
            return out(dict(report, ok=not report["problems"]), 0 if not report["problems"] else 1)
        if args.command == "env":
            return out(instance.env({}))
        instance.stop()
        return out({"ok": True, "manager_running": instance.manager_running() if installed() else False})
    except Problem as err:
        return out({"ok": False, "error": str(err)}, 1)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
