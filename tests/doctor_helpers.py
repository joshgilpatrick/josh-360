"""A made-up laptop for the doctor's tests (JP-152): a home folder, a user folder, a small git copy of josh-360 at
home/repo, a real ledger, and a runner that stands in for launchctl, az, security and node. Nothing real is touched."""
from __future__ import annotations

import datetime
import gzip
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Dict, List, Tuple

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(REPO / "scripts"))
import doctor  # noqa: E402,F401  (importing it registers every check)
from doctor_lib import core  # noqa: E402
from ledger import db as ledger_db  # noqa: E402

NOW = datetime.datetime(2026, 11, 17, 21, 0, 0, tzinfo=datetime.timezone.utc)
STAMP = "2026-11-17T20:58:00Z"
SECRET_TOKEN = "SECRET-TOKEN-do-not-print"
SECRET_EMAIL = "made.up.person@example.invalid"
SECRET_IN_SETTINGS = "SECRET-IN-SETTINGS-do-not-print"
COPY_PARTS = ["jobs.yaml", "hooks", "laptop", "ledger", "scripts", "graphs", "conventions"]
IGNORE = shutil.ignore_patterns("__pycache__", "*.pyc", "tests", "node_modules", ".git")
ALL_EVENTS = ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop",
              "SubagentStop", "PreCompact", "PostCompact"]

ADD_HOOKS_STUB = '''#!/usr/bin/env python3
import json, sys
args = sys.argv[1:]
path = args[args.index("--settings") + 1]
data = json.load(open(path)) if __import__("os").path.exists(path) else {}
open(path + ".bak-josh-360", "w").write(json.dumps(data))
for event in %r:
    data.setdefault("hooks", {}).setdefault(event, [{"matcher": "*", "hooks": [{"type": "command", "timeout": 60,
        "command": 'f="$HOME/.josh-360/repo/hooks/dispatch"; [ -x "$f" ] || exit 0; exec "$f" ' + event}]}])
json.dump(data, open(path, "w"))
print("added hook entries")
''' % (ALL_EVENTS,)


def git(*args: str, cwd: Path) -> str:
    env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@invalid", GIT_COMMITTER_NAME="t",
               GIT_COMMITTER_EMAIL="t@invalid", GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_SYSTEM="/dev/null")
    done = subprocess.run(["git", "-c", "core.hooksPath=/dev/null"] + list(args), cwd=str(cwd), env=env,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
    if done.returncode != 0:
        raise AssertionError("git {} failed: {}".format(args, done.stderr))
    return done.stdout.strip()


def snapshot(*roots: Path) -> Dict[str, Tuple]:
    """Every file and folder under the roots, with size and mtime: two equal snapshots mean nothing was changed."""
    seen: Dict[str, Tuple] = {}
    for root in roots:
        for dirpath, dirnames, filenames in os.walk(str(root)):
            seen[dirpath] = ("dir",)
            for name in filenames:
                p = os.path.join(dirpath, name)
                st = os.stat(p)
                seen[p] = (st.st_size, st.st_mtime_ns, st.st_mode)
    return seen


class DoctorCase(unittest.TestCase):
    template: Path

    @classmethod
    def setUpClass(cls) -> None:
        cls.template = Path(tempfile.mkdtemp(prefix="josh360-doctor-template-"))
        for part in COPY_PARTS:
            src = REPO / part
            if src.is_dir():
                shutil.copytree(str(src), str(cls.template / part), ignore=IGNORE, symlinks=True)
            else:
                shutil.copy2(str(src), str(cls.template / part))
        git("init", "-q", "-b", "main", cwd=cls.template)
        git("add", "-A", cwd=cls.template)
        git("commit", "-q", "-m", "made-up main", cwd=cls.template)
        sha = git("rev-parse", "HEAD", cwd=cls.template)
        git("update-ref", "refs/remotes/origin/main", sha, cwd=cls.template)
        git("checkout", "-q", "--detach", cwd=cls.template)
        cls.sha = sha

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(str(cls.template), True)

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="josh360-doctor-"))
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.home = self.tmp / "j360"
        self.user = self.tmp / "user"
        self.copy = self.home / "repo"
        shutil.copytree(str(self.template), str(self.copy), symlinks=True)
        for d in ("state", "logs", "backups", "atlas"):
            (self.home / d).mkdir(parents=True, exist_ok=True)
        (self.user / ".claude" / "scripts").mkdir(parents=True)
        (self.user / ".local" / "bin").mkdir(parents=True)
        self._old_home = os.environ.get("JOSH360_HOME")
        os.environ["JOSH360_HOME"] = str(self.home)
        self.addCleanup(self._restore)

        self.stubs = self.tmp / "stubs"
        self.stubs.mkdir()
        for name in ("node", "az"):
            (self.stubs / name).write_text("#!/bin/sh\nexit 0\n")
            (self.stubs / name).chmod(0o755)
        claude = self.user / ".local" / "bin" / "claude"
        claude.write_text("#!/bin/sh\nexit 0\n")
        claude.chmod(0o755)

        self.loaded = {core.JOBS_RUNNER_LABEL, "com.josh360.session-atlas"}
        self.az_code = 0
        self.keychain_code = 0
        self.health = 200
        self.ls_remote = (0, "", "")
        self.calls: List[List[str]] = []
        self.env = {"PATH": str(self.stubs) + ":" + os.environ.get("PATH", ""), "JOSH360_NODE": str(self.stubs / "node"),
                    "JOSH360_AZ": str(self.stubs / "az"), "JOSH360_JIRA_TOKEN": SECRET_TOKEN}
        self.build_healthy()

    def _restore(self) -> None:
        if self._old_home is None:
            os.environ.pop("JOSH360_HOME", None)
        else:
            os.environ["JOSH360_HOME"] = self._old_home

    # -- the made-up parts ---------------------------------------------------------------------------------------------
    def build_healthy(self) -> None:
        state, now = self.home / "state", NOW.timestamp()
        (state / "installed.json").write_text(json.dumps({"commit": self.sha}))
        jobs = core.common.validate_jobs(core.common.parse_jobs_text((self.copy / "jobs.yaml").read_text()), self.copy)
        (state / "jobs-state.json").write_text(json.dumps(
            {j["id"]: {"last_run": now - (120 if j["every"] else 1000), "last_result": 0} for j in jobs}))
        ledger_db.ensure(state / "ledger.db", self.home / "backups", STAMP)
        conn = ledger_db.connect(state / "ledger.db")
        machine = ledger_db.machine_id(conn)
        uid = "{}:claude-code:sess-0001".format(machine)
        conn.execute("INSERT INTO sessions (session_uid, machine_id, tool, tool_session_id, started_at, started_by, "
                     "recorded_at, recorded_by) VALUES (?, ?, 'claude-code', 'sess-0001', ?, 'josh', ?, 'test')",
                     (uid, machine, STAMP, STAMP))
        conn.execute("INSERT INTO session_episodes (session_uid, episode, began_at, last_activity_at, quiet_at, end_reason, "
                     "version, recorded_at, recorded_by) VALUES (?, 1, ?, ?, ?, 'quiet', 1, ?, 'test')", (uid, STAMP, STAMP, STAMP, STAMP))
        conn.execute("INSERT INTO ticket_offers (session_uid, event, offer_trigger, at, recorded_by) "
                     "VALUES (?, 'offered', 'first-commit', ?, 'test')", (uid, STAMP))
        conn.execute("INSERT INTO comment_deliveries (tracker, ticket_key, comment_id, author_account, session_uid, via, "
                     "delivered_at, recorded_by) VALUES ('jira', 'JP-900', 'c1', 'acct', ?, 'hook-file', ?, 'test')", (uid, STAMP))
        conn.execute("INSERT INTO session_summaries (session_uid, episode, method, lines, written_at, recorded_by) "
                     "VALUES (?, 1, 'copied', 'a made-up line', ?, 'test')", (uid, STAMP))
        conn.execute("INSERT INTO session_facts (session_uid, episode, fact, value, recorded_at, recorded_by) "
                     "VALUES (?, 1, 'tool_errors', 0, ?, 'test')", (uid, STAMP))
        conn.close()
        cache = sqlite3.connect(str(state / "cache.db"))
        cache.executescript("CREATE TABLE cost (id INTEGER); PRAGMA user_version = 3;")
        cache.close()
        backup = self.home / "backups" / "ledger-2026-11-17.db.gz"
        with gzip.open(str(backup), "wb") as f:
            f.write(b"made up")
        os.utime(str(backup), (NOW.timestamp() - 3600, NOW.timestamp() - 3600))
        (state / "azure-backup.json").write_text(json.dumps({"account": "madeupstorage", "container": "madeup-backups"}))
        (state / "azure-upload.json").write_text(json.dumps({"last_success": "2026-11-17T06:00:00Z"}))
        (state / "jira-email").write_text(SECRET_EMAIL + "\n")
        (self.home / "atlas" / "atlas.log").write_text("atlas listening\n")
        (self.user / "Archive" / "josh-360-retired" / "2026-11-17" / "session-atlas").mkdir(parents=True)
        self.write_settings(ALL_EVENTS)
        (self.user / ".claude" / "scripts" / "add-josh-360-hooks.py").write_text(ADD_HOOKS_STUB)

    def write_settings(self, events) -> None:
        hooks = {e: [{"matcher": "*", "hooks": [{"type": "command", "timeout": 60,
                                                  "command": 'f="$HOME/.josh-360/repo/hooks/dispatch"; [ -x "$f" ] || exit 0; exec "$f" ' + e}]}]
                 for e in events}
        (self.user / ".claude" / "settings.json").write_text(json.dumps(
            {"env": {"API_TOKEN": SECRET_IN_SETTINGS}, "hooks": hooks}))

    def runner(self, argv, timeout):
        self.calls.append(list(argv))
        prog = os.path.basename(argv[0])
        if prog == "launchctl":
            return (0 if argv[2].split("/")[-1] in self.loaded else 113), "", ""
        if prog == "az":
            return self.az_code, "", ""
        if prog == "security":
            return self.keychain_code, "", ""
        if prog == "node":
            return 0, "v22.20.0\n", ""
        if "ls-remote" in argv:
            return self.ls_remote
        return core._default_runner(argv, timeout)

    def http(self, url, timeout):
        return self.health, ""

    def ctx(self, **kw) -> core.Ctx:
        args = dict(home=self.home, user_home=self.user, env=self.env, now=NOW, runner=self.runner, http_get=self.http,
                    code_root=self.copy)
        args.update(kw)
        return core.Ctx(**args)

    def results(self, **kw) -> Dict[str, core.Result]:
        return {r.id: r for r in core.run_checks(self.ctx(**kw))}
