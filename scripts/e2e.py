#!/usr/bin/env python3
"""Prove a ticket's whole graph run in the cloud (JP-188). Python 3.9 or newer, standard library only.

One command carries the made-up fixture ticket (JP-9116) from Jira to an ended run on a sandbox laptop, with the real
Agent Manager (JP-186), the stand-in Claude Code and the strict fake Jira (JP-187):

    python3 scripts/e2e.py --scenario triage-happy --evidence <folder>
    python3 scripts/e2e.py --all --evidence <folder>      # every scenario, each in <folder>/<scenario>/
    python3 scripts/e2e.py --list

It launches a verify-josh-360 sandbox laptop (its own HOME and a bare `origin.git` for GitHub), starts a pinned Agent
Manager whose home is that HOME, makes a strict fake Jira holding the fixture, then runs the laptop's job runner
(`laptop/run_jobs.py`, which runs `graphs/runner/tick_job.py` as the `graph-runner` job) pass after pass until the run
ends or a limit passes. Every pass runs the way launchd runs it on the laptop: Python 3.9, a PATH with no
`~/.local/bin`, no credentials. Between passes the driver moves the sandbox's clock five minutes on (the laptop's
pace), so a run that takes an hour of laptop time takes a few minutes. The scenario files are `tests/e2e/runs/*.json`;
`tests/e2e/README.md` describes them.

The sandbox is set up the way Josh's laptop is, so a run trips on what the laptop trips on (JP-190): the Jira email is
only in `~/.josh-360/state/jira-email` and the fake Jira refuses a client without it; Claude Code is only in
`~/.local/bin`, which a job's PATH does not hold; and the ledger recorder reads a local stand-in for Jira's REST API
(slow when a scenario asks), never the real site. A scenario can also change the binding's settings, the models the
laptop's Claude Code lists, give the recorder a backlog of made-up sessions, or mark a once job as done long ago.

Everything it saw goes in the evidence folder (runner.log, the run folder, the run report, the fake Jira's calls,
Agent Manager's sessions and calls, the stand-in's log, each pass) with `verdict.json` on top. Exit 0 when every check
of the scenario passed, 1 when one failed, 2 when the harness could not run (a missing tool or bad input).
"""
from __future__ import annotations

import argparse
import datetime
import importlib.util
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Dict, List, Optional

ROOT = Path(__file__).resolve().parent.parent
E2E = ROOT / "tests" / "e2e"
RUNS = E2E / "runs"
CLOCK_DIR = E2E / "clock"
SANDBOX = ROOT / ".claude" / "skills" / "verify-josh-360" / "scripts" / "sandbox.py"
PASS_SECONDS = 300                          # the laptop's job runner runs every five minutes
# The job runner's PATH on the laptop is the startup list's (macbook-automations, com.jgilpatrick.josh-360-jobs.plist):
# /opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin. Here the sandbox's own `homebrew/bin` (the stand-in
# gh, JP-198) takes Homebrew's place; /usr/local/bin is left out because a cloud machine keeps the real gh there. Claude
# Code is in neither, as on the laptop: only in ~/.local/bin.
JOB_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"
GITHUB_REPO = "joshgilpatrick/josh-360"      # the repository the registry's josh-360 system names; the stand-in gh serves it
SETTLE_PASSES = 1                            # passes run after the run ends: the next tick places its sessions
QUIET_SECONDS = 120                          # real seconds a pass may wait for the sessions it started to rest
JIRA_EMAIL = "josh@example.test"             # made up: the laptop keeps the real one in ~/.josh-360/state/jira-email
JIRA_TOKEN = "made-up-token"                 # made up: stands in for the laptop's keychain item, which Linux lacks
BACKLOG_EPIC = "JP-94"
sys.path.insert(0, str(E2E))
sys.path.insert(0, str(ROOT / "graphs" / "gates"))
import agent_manager  # noqa: E402
from lib import jira_strict  # noqa: E402


class Problem(Exception):
    """The harness cannot run (exit 2). The message says what is missing."""


def stamp() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def write_json(path: Path, doc: object) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    return path


def read_json(path: Path) -> Optional[dict]:
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
        return doc if isinstance(doc, dict) else None
    except (OSError, ValueError):
        return None


def load_sandbox():
    spec = importlib.util.spec_from_file_location("verify_josh360_sandbox", str(SANDBOX))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)                                      # type: ignore[union-attr]
    return module


# -- what a scenario says --------------------------------------------------------------------------------------------

def scenarios() -> Dict[str, dict]:
    return {p.stem: json.loads(p.read_text(encoding="utf-8")) for p in sorted(RUNS.glob("*.json"))}


def scenario(name: str) -> dict:
    found = scenarios().get(name)
    if found is None:
        raise Problem("no scenario '{}'; there are: {}".format(name, ", ".join(scenarios()) or "none"))
    return found


def standin_plan(doc: dict) -> dict:
    """The stand-in's plan with each scenario that names a file in tests/e2e/scenarios/ made absolute."""
    plan = json.loads(json.dumps(doc.get("plan") or {"default": "example"}))
    def absolute(name):
        return str(E2E / "scenarios" / name) if isinstance(name, str) and name.endswith(".json") else name

    for step, name in list((plan.get("steps") or {}).items()):   # a list is one scenario per attempt (JP-194)
        plan["steps"][step] = [absolute(n) for n in name] if isinstance(name, list) else absolute(name)
    return plan


# -- tools -----------------------------------------------------------------------------------------------------------

def find_python(given: Optional[str]) -> str:
    """The laptop's Python is 3.9: --python, $JOSH360_E2E_PYTHON, python3.9 on PATH, or uv's 3.9."""
    candidates = [given, os.environ.get("JOSH360_E2E_PYTHON"), shutil.which("python3.9")]
    if not any(candidates) and shutil.which("uv"):
        found = subprocess.run(["uv", "python", "find", "3.9"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                               universal_newlines=True)
        candidates.append(found.stdout.strip() if found.returncode == 0 else None)
    for path in candidates:
        if not path:
            continue
        done = subprocess.run([path, "-c", "import sys; print('%d.%d' % sys.version_info[:2])"],
                              stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, universal_newlines=True)
        if done.returncode == 0 and done.stdout.strip() == "3.9":
            return str(Path(path).absolute())
    raise Problem("no Python 3.9 (the laptop's): install one (uv python install 3.9) or pass --python")


def check_tools() -> Path:
    problems = agent_manager.missing_tools()
    am = agent_manager.installed()
    if not am:
        problems.append("Agent Manager {} is not installed: python3 tests/e2e/agent_manager.py install".format(
            agent_manager.PINNED))
    if problems:
        raise Problem("; ".join(problems))
    return am


# -- the sandbox laptop ----------------------------------------------------------------------------------------------

class Laptop:
    """A sandbox laptop with Agent Manager, the fake Jira and the clock wired in."""

    def __init__(self, meta: dict, am_bin: Path, python: str, doc: dict, evidence: Path):
        self.meta, self.python, self.doc, self.evidence = meta, python, doc, evidence
        self.root = Path(meta["root"])
        self.home = Path(meta["home"])
        self.josh = self.home / ".josh-360"
        self.copy = self.josh / "repo"
        self.jira = self.root / "jira"
        self.clock = self.root / "clock"
        self.starts = self.root / "starts.json"
        self.am = agent_manager.Instance(self.root, am_bin)      # its home is the sandbox's HOME
        self.ticket = doc.get("ticket", "JP-9116")
        self.binding_json = self.root / "binding.json"
        self.claude_models = self.root / "claude-models.json"
        self.recorder_jira: Optional[ThreadingHTTPServer] = None
        self.homebrew = self.root / "homebrew" / "bin"           # stands in for /opt/homebrew/bin: the stand-in gh
        self.github = self.root / "github"                       # the stand-in gh's folder (JP-198)
        self.origin = self.root / "origin.git"
        self.clone = self.home / "Development" / "active" / "josh_360"   # the registry's folder for josh-360

    # -- setting up ---------------------------------------------------------------------------------------------
    def setup(self) -> None:
        self.clock.write_text("0\n", encoding="utf-8")
        self.am.setup()
        self.am.rails(self.copy)                     # ~/.claude/settings.json names the copy's hooks/dispatch
        self.am.plan(**standin_plan(self.doc))
        jira_strict.install(self.jira, fixtures=(self.ticket,))
        state = json.loads((self.jira / "fake-jira.json").read_text(encoding="utf-8"))
        state["apply_jql"] = True
        for key, extra in (self.doc.get("issues") or {}).items():         # made-up neighbours, such as the epic
            state["issues"][key] = {"key": key, "fields": {}}
            _fill(state["issues"][key]["fields"], extra)
        _fill(state["issues"][self.ticket]["fields"], self.doc.get("fixture") or {})
        (self.jira / "fake-jira.json").write_text(json.dumps(state), encoding="utf-8")
        write_json(self.starts, self.doc["starts"])
        self.laptop_like()
        self.github_like()
        if self.doc.get("route_signed"):
            self.sign_route()
        self.am.start_manager()

    def github_like(self) -> None:
        """The laptop's `gh` (JP-198): the stand-in on the job's PATH where Homebrew would be, serving the sandbox's
        bare `origin.git` as GitHub's joshgilpatrick/josh-360. With `github` in the scenario, the josh-360 clone the
        registry names is made too, its `origin` that same repository under the path GitHub would give it."""
        self.homebrew.mkdir(parents=True, exist_ok=True)
        if not (self.homebrew / "gh").exists():
            os.symlink(str(E2E / "standin" / "gh"), str(self.homebrew / "gh"))
        named = self.github / "repos" / (GITHUB_REPO + ".git")   # .../joshgilpatrick/josh-360.git -> origin.git
        named.parent.mkdir(parents=True, exist_ok=True)
        if not named.exists():
            os.symlink(str(self.origin), str(named))
        settings = self.doc.get("github") or {}
        write_json(self.github / "config.json", {"repos": {GITHUB_REPO: str(named)},
                                                  "audit": settings.get("audit") or {"after_seconds": PASS_SECONDS},
                                                  "checks": settings.get("checks") or [{"name": "suite"},
                                                                                       {"name": "e2e"}]})
        if self.doc.get("github") is not None and not self.clone.exists():
            self.clone.parent.mkdir(parents=True, exist_ok=True)
            done = subprocess.run(["git", "clone", "--quiet", str(named), str(self.clone)], stdout=subprocess.PIPE,
                                  stderr=subprocess.STDOUT, universal_newlines=True)
            if done.returncode != 0:
                raise Problem("the josh-360 clone could not be made: {}".format(done.stdout.strip()[-300:]))

    def sign_route(self) -> None:
        """Triage's sign-off, already given: the route record's version is the ticket's own, read the way the entry
        gate reads it, so a scenario can start a run at Ready without a triage run first."""
        env = dict(self.env(), JOSH360_JIRA_EMAIL=JIRA_EMAIL)
        code = ("import sys; sys.path.insert(0, '.'); from lib.jira import Jira; from lib.triage import port; "
                "print(port.read_ticket(Jira.from_env(), sys.argv[1], subtasks=False).version)")
        done = subprocess.run([self.python, "-c", code, self.ticket], cwd=str(self.copy / "graphs" / "gates"), env=env,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=120)
        version = done.stdout.strip().splitlines()[-1] if done.returncode == 0 and done.stdout.strip() else ""
        if not version:
            raise Problem("the route record could not be signed: {}".format(done.stderr.strip()[-300:]))
        marker = self.jira / "fake-jira.json"
        state = json.loads(marker.read_text(encoding="utf-8"))
        route = state.setdefault("properties", {}).setdefault("{}|josh360.route".format(self.ticket), {})
        route["version"] = version
        marker.write_text(json.dumps(state), encoding="utf-8")

    def laptop_like(self) -> None:
        """What the laptop has and the earlier harness papered over (JP-190), plus the scenario's own changes."""
        state = self.josh / "state"
        state.mkdir(parents=True, exist_ok=True)
        (state / "jira-email").write_text(JIRA_EMAIL + "\n", encoding="utf-8")       # JP-171: the email is only here
        write_json(self.jira / "credentials.json", {"email": JIRA_EMAIL, "token": JIRA_TOKEN})
        local_bin = self.home / ".local" / "bin"                                     # Claude Code's own install folder
        local_bin.mkdir(parents=True, exist_ok=True)
        if not (local_bin / "claude").exists():
            os.symlink(str(E2E / "standin" / "claude"), str(local_bin / "claude"))
        if self.doc.get("binding"):
            cfg = json.loads((ROOT / "graphs" / "bindings" / "agent-manager" / "binding.json").read_text(encoding="utf-8"))
            cfg.update(self.doc["binding"])
            write_json(self.binding_json, cfg)
        if self.doc.get("claude_lists") is not None:
            listed = json.loads((E2E / "laptop-models.json").read_text(encoding="utf-8"))
            listed["models"] = [m for m in listed["models"] if m["value"] in self.doc["claude_lists"]]
            write_json(self.claude_models, listed)
        backlog = self.doc.get("backlog") or {}
        if backlog.get("sessions"):
            made_up_backlog(self.home / ".claude" / "projects" / "-made-up-backlog", int(backlog["sessions"]))
        self.recorder_jira = recorder_jira(float(backlog.get("jira_delay", 0)))
        if self.doc.get("jobs_done"):
            jobs_state = state / "jobs-state.json"
            record = read_json(jobs_state) or {}
            for job in self.doc["jobs_done"]:
                record[job] = {"last_run": time.time(), "last_result": 0}
            write_json(jobs_state, record)

    def stop(self) -> None:
        self.am.stop()
        if self.recorder_jira is not None:
            self.recorder_jira.shutdown()
            self.recorder_jira.server_close()
            self.recorder_jira = None

    def env(self) -> Dict[str, str]:
        """A launchd job's environment on the laptop, pointed at this sandbox's Agent Manager, Jira and clock."""
        sandbox = load_sandbox()
        env = sandbox.sandbox_env(self.meta)
        am = self.am.env(env)
        # Not JOSH360_CLAUDE_BIN: the laptop sets no such thing, so the binding must find ~/.local/bin/claude itself.
        for key in ("XDG_CONFIG_HOME", "TMUX_TMPDIR", "JOSH360_AM_BIN", "JOSH360_E2E_REAL_AM", "JOSH360_E2E_AM_LOG",
                    "JOSH360_AM_DB", "JOSH360_STANDIN_LOG", "JOSH360_STANDIN_PLAN"):
            env[key] = am[key]
        env.update({"PATH": str(self.homebrew) + os.pathsep + JOB_PATH, "JOSH360_STANDIN_GH": str(self.github),
                    "JOSH360_JIRA_FAKE": str(self.jira), "JOSH360_RUNNER_STARTS": str(self.starts),
                    "JOSH360_NO_NOTIFY": "1", "JOSH360_E2E_CLOCK": str(self.clock), "PYTHONPATH": str(CLOCK_DIR),
                    "LANG": "C.UTF-8", "JOSH360_JIRA_TOKEN": JIRA_TOKEN,
                    "NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost"})
        if self.recorder_jira is not None:
            env["JOSH360_JIRA_SITE"] = "http://127.0.0.1:{}".format(self.recorder_jira.server_address[1])
        if self.binding_json.is_file():
            env["JOSH360_AM_BINDING_JSON"] = str(self.binding_json)
        if self.claude_models.is_file():
            env["JOSH360_STANDIN_MODELS"] = str(self.claude_models)
        for key in ("PYTHONHOME", "VIRTUAL_ENV", "TMUX", "TMUX_PANE", "JOSH360_CLAUDE_BIN", "JOSH360_JIRA_EMAIL",
                    "ACTION_AGENT_JIRA_EMAIL"):
            env.pop(key, None)
        return env

    # -- the clock ------------------------------------------------------------------------------------------------
    def offset(self) -> float:
        try:
            return float(self.clock.read_text(encoding="utf-8").strip() or 0)
        except (OSError, ValueError):
            return 0.0

    def jump(self, seconds: float) -> None:
        self.clock.write_text("{}\n".format(self.offset() + seconds), encoding="utf-8")

    # -- running things on it --------------------------------------------------------------------------------------
    def run(self, argv: List[str], timeout: float = 900) -> subprocess.CompletedProcess:
        return subprocess.run(argv, cwd=str(self.copy), env=self.env(), stdin=subprocess.DEVNULL,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=timeout)

    def ledger(self, sql: str, args: tuple = ()) -> List[dict]:
        db = self.josh / "state" / "ledger.db"
        if not db.is_file():
            return []
        conn = sqlite3.connect("file:{}?mode=ro".format(db), uri=True, timeout=30)
        conn.row_factory = sqlite3.Row
        try:
            return [dict(r) for r in conn.execute(sql, args).fetchall()]
        finally:
            conn.close()

    def ticket_runs(self) -> List[dict]:
        """Every graph run on the ticket, with how it ended (None while it is open)."""
        rows = self.ledger("SELECT run_id, graph_id FROM graph_runs WHERE ticket_key = ? ORDER BY id", (self.ticket,))
        return [{"run": r["run_id"], "graph": r["graph_id"], "ended": self.ended(r["run_id"])} for r in rows]

    def gh_calls(self) -> List[dict]:
        return _lines(self.github / "calls.jsonl")

    def gh_state(self) -> dict:
        return read_json(self.github / "state.json") or {}

    def git(self, folder: Path, *args: str) -> Optional[str]:
        done = subprocess.run(["git"] + list(args), cwd=str(folder), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              universal_newlines=True)
        return done.stdout.strip() if done.returncode == 0 else None

    def run_id(self) -> Optional[str]:
        rows = self.ledger("SELECT run_id FROM graph_runs WHERE ticket_key = ? AND graph_id = ? ORDER BY id DESC LIMIT 1",
                           (self.ticket, self.doc["graph"]))
        return rows[0]["run_id"] if rows else None

    def run_folder(self, run_id: str) -> Path:
        return self.josh / "runs" / run_id

    def run_doc(self, run_id: Optional[str]) -> Optional[dict]:
        return read_json(self.run_folder(run_id) / "run.json") if run_id else None

    def ended(self, run_id: Optional[str]) -> Optional[str]:
        if not run_id:
            return None
        rows = self.ledger("SELECT end_name FROM run_ends WHERE run_id = ? ORDER BY version DESC LIMIT 1", (run_id,))
        return rows[0]["end_name"] if rows else None

    def busy(self) -> List[str]:
        """What still moves on its own: an `advance` holding its lock, or a session Agent Manager says is not at rest."""
        found = []
        runs = self.josh / "runs"
        for lock in runs.glob("*/advance.lock") if runs.is_dir() else []:
            if _held(lock):
                found.append("advance {}".format(lock.parent.name))
        for row in self.am_sessions():
            if not row.get("archived") and row.get("status") in ("starting", "working"):
                found.append("session {} {}".format(row.get("name"), row.get("status")))
        return found

    def quiet(self, limit: float = QUIET_SECONDS) -> List[str]:
        deadline = time.monotonic() + limit
        time.sleep(1.0)
        while True:
            left = self.busy()
            if not left or time.monotonic() >= deadline:
                return left
            time.sleep(1.0)

    def am_sessions(self) -> List[dict]:
        if not self.am.db.is_file():
            return []
        conn = sqlite3.connect("file:{}?mode=ro".format(self.am.db), uri=True, timeout=30)
        conn.row_factory = sqlite3.Row
        try:
            return [dict(r) for r in conn.execute("SELECT * FROM sessions ORDER BY rowid").fetchall()]
        except sqlite3.Error:
            return []
        finally:
            conn.close()

    def ticket_sessions(self) -> List[dict]:
        """The ticket's sessions in Agent Manager: the runner names each `<KEY>(<letter>) - <Step>` (JP-173)."""
        return [r for r in self.am_sessions() if str(r.get("name") or "").startswith(self.ticket + "(")]

    def jira_status(self) -> Optional[str]:
        return ((self.jira_issue().get("fields") or {}).get("status") or {}).get("name")

    def jira_issue(self) -> dict:
        state = read_json(self.jira / "fake-jira.json") or {}
        return (state.get("issues") or {}).get(self.ticket) or {}


def _fill(fields: dict, values: dict) -> None:
    for name, value in values.items():
        fields[name] = {"name": value} if name in ("status", "issuetype") else value


def _held(lock: Path) -> bool:
    import fcntl
    try:
        fd = os.open(str(lock), os.O_RDWR)
    except OSError:
        return False
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(fd, fcntl.LOCK_UN)
        return False
    except OSError:
        return True
    finally:
        os.close(fd)


def made_up_backlog(folder: Path, count: int) -> None:
    """`count` quiet made-up sessions, each on its own made-up ticket, for the ledger recorder to catch up on (JP-181:
    the backlog that once kept ledger-record past its timeout and held up the graph runner behind it)."""
    folder.mkdir(parents=True, exist_ok=True)
    quiet = time.time() - 3600
    for n in range(count):
        sid = "backlog-{:05d}".format(n)
        lines = []
        for i, kind in enumerate(("user", "assistant", "user", "assistant")):
            lines.append(json.dumps({"type": kind, "timestamp": "2026-11-19T09:0{}:00Z".format(i), "sessionId": sid,
                                     "uuid": "u-{}-{}".format(sid, i), "isSidechain": False,
                                     "cwd": "/tmp/made-up/josh_360", "gitBranch": "JP-{}-made-up".format(20000 + n),
                                     "message": {"role": kind, "content": "made-up text"}}))
        path = folder / (sid + ".jsonl")
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        os.utime(str(path), (quiet, quiet))


def recorder_jira(delay: float) -> ThreadingHTTPServer:
    """A local stand-in for the Jira REST reads the laptop's ledger jobs make (`ledger/jira_read.py`): every issue is a
    made-up Task under a made-up epic, answered after `delay` seconds (the recorder's slow reads, JP-181), and every
    comment page is empty, at once (so the comment relay does not slow the run down too). It never reaches the real
    site."""

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            if "/rest/api/3/issue/" not in self.path:
                self.send_error(404)
                return
            key = self.path.split("/issue/")[1].split("?")[0]
            if key.endswith("/comment"):
                doc = {"comments": [], "startAt": 0, "maxResults": 50, "total": 0}
            else:
                time.sleep(delay)
                fields = {"labels": [], "issuelinks": [],
                          "issuetype": {"name": "Epic" if key == BACKLOG_EPIC else "Task"}}
                if key != BACKLOG_EPIC:
                    fields["parent"] = {"key": BACKLOG_EPIC}
                doc = {"key": key, "names": {}, "fields": fields}
            body = json.dumps(doc).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):  # noqa: N802
            self.send_error(405)

        do_PUT = do_POST

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


# -- driving ---------------------------------------------------------------------------------------------------------

def launch(run: str, evidence: Path, allow_dirty: bool) -> dict:
    argv = [sys.executable, str(SANDBOX), "launch", "--run", run, "--evidence", str(evidence / "sandbox")]
    if allow_dirty:
        argv.append("--allow-dirty")
    done = subprocess.run(argv, cwd=str(ROOT), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          universal_newlines=True, timeout=900)
    try:
        said = json.loads(done.stdout)
    except ValueError:
        said = {"ok": False, "error": (done.stdout + done.stderr).strip()[-1000:]}
    if not said.get("ok"):
        raise Problem("the sandbox laptop did not launch: {}".format(said.get("error") or said.get("install_tail")))
    return json.loads((Path(said["root"]) / ".verify-josh-360").read_text(encoding="utf-8"))


def drive(laptop: Laptop, doc: dict, passes_log: Path, limit_minutes: float, wall_limit: float) -> dict:
    """Pass after pass of the job runner until the run ends, stops where the scenario says it stops, or a limit."""
    began = time.monotonic()
    outcome = {"why": "limit", "passes": 0}
    want_stop = (doc.get("expect") or {}).get("stopped_at")
    want_passes = doc.get("passes")                 # a scenario that is about the passes themselves, not the run's end
    after_stop = int(doc.get("after_stop_passes", 0))
    settle, stopped_for = 0, 0
    while True:
        e2e_minutes = laptop.offset() / 60.0
        if e2e_minutes >= limit_minutes:
            outcome["why"] = "e2e time limit ({} minutes)".format(limit_minutes)
            break
        if time.monotonic() - began >= wall_limit:
            outcome["why"] = "real time limit ({} seconds)".format(wall_limit)
            break
        laptop.jump(PASS_SECONDS)
        outcome["passes"] += 1
        started_at = time.time() + laptop.offset()   # when the pass began on the laptop's clock
        done = laptop.run([laptop.python, "laptop/run_jobs.py"], timeout=900)
        left = laptop.quiet()
        run_id = laptop.run_id()
        run = laptop.run_doc(run_id) or {}
        ended = laptop.ended(run_id)
        line = {"pass": outcome["passes"], "e2e_minutes": round(laptop.offset() / 60.0, 1), "started_at": started_at,
                "real_seconds": round(time.monotonic() - began, 1), "run_jobs_exit": done.returncode,
                "run_jobs": done.stdout.strip().splitlines(), "run_jobs_stderr": done.stderr.strip()[-2000:],
                "run": run_id, "ended": ended, "stopped": run.get("stopped"), "still_busy": left,
                "jira_status": laptop.jira_status(), "sessions": [_brief(r) for r in laptop.ticket_sessions()],
                "ticket_runs": laptop.ticket_runs()}
        with open(str(passes_log), "a", encoding="utf-8") as handle:
            handle.write(json.dumps(line, sort_keys=True) + "\n")
        if want_passes and outcome["passes"] >= int(want_passes):
            outcome["why"] = "passes"
            break
        if ended:
            outcome["why"] = "ended"
            settle += 1
            if settle > SETTLE_PASSES:     # the passes after the end file the ticket's sessions, as on the laptop
                break
            continue
        if want_stop and (run.get("stopped") or {}).get("step") == want_stop:
            if not stopped_for:
                outcome.update(why="stopped", stopped_e2e_minutes=round(laptop.offset() / 60.0, 1))
            stopped_for += 1
            if stopped_for > after_stop:   # the passes after the stop show it stays stopped and spawns nothing more
                break
    outcome.update(e2e_minutes=round(laptop.offset() / 60.0, 1), real_seconds=round(time.monotonic() - began, 1))
    outcome.setdefault("stopped_e2e_minutes", outcome["e2e_minutes"])
    return outcome


# -- evidence --------------------------------------------------------------------------------------------------------

def collect(laptop: Laptop, evidence: Path, run_id: Optional[str]) -> dict:
    """Copy what the run left into the evidence folder and return what the checks read."""
    logs = laptop.josh / "logs"
    if logs.is_dir():
        shutil.copytree(str(logs), str(evidence / "logs"), dirs_exist_ok=True)
    state = laptop.josh / "state"
    for name in ("jobs-state.json", "runner/report.json", "runner/am-tickets.json"):
        if (state / name).is_file():
            target = evidence / "state" / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(str(state / name), str(target))
    if run_id and laptop.run_folder(run_id).is_dir():
        shutil.copytree(str(laptop.run_folder(run_id)), str(evidence / "run"), dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns("*.lock"))
    report = {}
    if run_id:
        done = laptop.run([laptop.python, "graphs/runner/runner.py", "report", "--run", run_id, "--json"], timeout=120)
        (evidence / "report.txt").write_text(done.stdout + done.stderr, encoding="utf-8")
        try:
            report = json.loads(done.stdout)
        except ValueError:
            report = {}
        write_json(evidence / "report.json", report)
        done = laptop.run([laptop.python, "graphs/tools/walker.py", "status", "--run", run_id], timeout=120)
        try:
            walker = json.loads(done.stdout)
        except ValueError:
            walker = {"error": (done.stdout + done.stderr).strip()[-1000:]}
        write_json(evidence / "walker-status.json", walker)
    for name in ("fake-jira.json", "calls.jsonl"):
        if (laptop.jira / name).is_file():
            target = evidence / "jira" / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(str(laptop.jira / name), str(target))
    sessions = laptop.am_sessions()
    write_json(evidence / "agent-manager" / "sessions.json", {"sessions": sessions})
    for src, name in ((laptop.am.calls_log, "am-calls.jsonl"), (laptop.am.standin_log, "standin.jsonl"),
                      (laptop.am.standin_plan, "standin-plan.json")):
        if src.is_file():
            shutil.copyfile(str(src), str(evidence / "agent-manager" / name))
    for name in ("calls.jsonl", "state.json", "config.json"):              # the stand-in gh (JP-198)
        if (laptop.github / name).is_file():
            target = evidence / "github" / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(str(laptop.github / name), str(target))
    return {"report": report, "am_sessions": sessions, "walker": read_json(evidence / "walker-status.json") or {}}


# -- the checks ------------------------------------------------------------------------------------------------------

def session_files(laptop: Laptop, run_id: Optional[str]) -> List[dict]:
    folder = laptop.run_folder(run_id) / "sessions" if run_id else None
    out = []
    for path in sorted(folder.glob("*.json")) if folder and folder.is_dir() else []:
        doc = read_json(path)
        if doc and "step" in doc and "attempt" in doc:
            out.append(doc)
    return out


def judge(laptop: Laptop, doc: dict, run_id: Optional[str], outcome: dict, seen: dict) -> List[dict]:
    expect = doc.get("expect") or {}
    checks: List[dict] = []

    def check(name: str, ok: bool, detail: object) -> None:
        checks.append({"check": name, "ok": bool(ok), "detail": detail})

    check("a run started for the ticket", bool(run_id), run_id)
    ended = laptop.ended(run_id)
    run = laptop.run_doc(run_id) or {}
    if "end" in expect:
        check("the run ended at its end state", ended == expect["end"], {"ended": ended, "want": expect["end"],
                                                                         "why_the_drive_stopped": outcome["why"]})
    if "jira_status" in expect:
        status = ((laptop.jira_issue().get("fields") or {}).get("status") or {}).get("name")
        check("the fake Jira shows the ticket in the status the graph sets", status == expect["jira_status"],
              {"status": status, "want": expect["jira_status"]})
    files = session_files(laptop, run_id)
    am_rows = {r["id"]: r for r in seen["am_sessions"]}
    if expect.get("one_session_per_role_step"):
        per_attempt = {}
        for f in files:
            handle = f.get("handle") or {}
            per_attempt["{}-{}".format(f["step"], f["attempt"])] = {
                "am_session": handle.get("am_session"), "in_agent_manager": handle.get("am_session") in am_rows,
                "earlier": len(f.get("earlier") or []), "state": f.get("state")}
        spawned = [c for c in laptop.am.calls("spawn") if c.get("code") == 0]
        # Only the ticket's own sessions count: the `console` terminal the console-terminal job keeps open (JP-196)
        # is an Agent Manager row too, but no role step's.
        mine = [r for r in am_rows.values() if str(r.get("name") or "").startswith(laptop.ticket + "(")]
        others = sorted(str(r.get("name")) for r in am_rows.values() if r not in mine)
        ok = bool(files) and all(v["in_agent_manager"] and not v["earlier"] for v in per_attempt.values()) \
            and len(spawned) == len(files) == len(mine)
        check("every role step has one Agent Manager session", ok,
              {"steps": per_attempt, "spawns": len(spawned), "agent_manager_sessions": len(mine),
               "other_agent_manager_rows": others})
    if expect.get("sessions_follow_status"):
        binding = _binding(laptop)
        completed = binding.completed_group()
        passes = _lines(laptop.evidence / "passes.jsonl")
        live_seen, wrong = 0, []
        for line in passes:                 # a session at work or at rest sits in the group for the ticket's status then
            want = binding.ticket_group(line.get("jira_status"))
            for row in line.get("sessions") or []:
                if row.get("status") != "dead" and not row.get("archived"):
                    live_seen += 1
                    if row.get("group_name") != want:
                        wrong.append({"pass": line["pass"], "session": row, "want": want})
        final = [_brief(r) for r in laptop.ticket_sessions()]
        done = laptop.jira_status() == "Done"
        put_away = [r for r in final if not (r["archived"] or (r["status"] == "dead" and (
            r["group_name"] == completed or (done and r is final[-1]))))]
        tickets = (read_json(laptop.josh / "state" / "runner" / "am-tickets.json") or {}).get("tickets") or {}
        group = (tickets.get(laptop.ticket) or {}).get("group")
        want_group = binding.ticket_group(laptop.jira_status())
        check("the ticket's sessions follow its status: a live one sits in the group for the ticket's status, a "
              "finished one is killed and filed in completed-steps (or archived)",
              live_seen > 0 and not wrong and bool(final) and not put_away and group == want_group,
              {"live_sightings": live_seen, "misplaced": wrong, "not_put_away": put_away, "final": final,
               "ticket_group": group, "want_ticket_group": want_group, "completed_group": completed})
    if "stopped_at" in expect:
        stopped = run.get("stopped") or {}
        check("the run stopped at the step", stopped.get("step") == expect["stopped_at"] and not ended,
              {"stopped": stopped, "ended": ended})
        limit = float(expect.get("within_minutes", 10))
        check("it stopped within {:g} minutes of e2e time".format(limit),
              outcome["why"] == "stopped" and outcome["stopped_e2e_minutes"] <= limit,
              {"e2e_minutes": outcome["stopped_e2e_minutes"], "why_the_drive_stopped": outcome["why"]})
    runner_log = laptop.josh / "logs" / "runner" / "runner.log"
    runner_text = runner_log.read_text(encoding="utf-8") if runner_log.is_file() else ""
    if expect.get("runner_log_names"):
        missing = [w for w in expect["runner_log_names"] if w not in runner_text]
        check("runner.log names what was refused, in the tool's own words", not missing,
              {"missing": missing, "log": str(runner_log)})
    # JP-171: every Jira call a gate or the runner made carried the email the laptop keeps in state/jira-email.
    calls = _lines(laptop.jira / "calls.jsonl")
    refused = [c for c in calls if c.get("status") == 401]
    check("every Jira call carried the credentials found the laptop's way (email only in state/jira-email)",
          bool(calls) and not refused, {"calls": len(calls), "refused_401": refused[:5]})
    if expect.get("admitted"):
        line = "start of {} for {} refused".format(doc["graph"], laptop.ticket)
        said = [x for x in runner_text.splitlines() if line in x]
        check("the entry gate admitted the run", bool(run_id) and not said, {"run": run_id, "refused": said[:3]})
    spawns = laptop.am.calls("spawn")
    if expect.get("claude_found"):
        # "claude is not installed": a job's PATH has no ~/.local/bin, where Claude Code is, so the binding must find it
        missing = [c for c in spawns if "not installed" in (str(c.get("stderr")) + str(c.get("stdout")))]
        check("Agent Manager found claude in ~/.local/bin under a job's PATH (no JOSH360_CLAUDE_BIN)",
              any(c.get("code") == 0 for c in spawns) and not missing,
              {"spawns": len(spawns), "not_installed": [c.get("stderr") for c in missing][:3]})
    if "spawns" in expect:
        check("Agent Manager was asked to spawn exactly {} time(s)".format(expect["spawns"]),
              len(spawns) == int(expect["spawns"]),
              {"spawns": [{"code": c.get("code"), "stderr": str(c.get("stderr"))[:300]} for c in spawns]})
    walker = seen.get("walker") or {}
    for step, want in (expect.get("cap_used") or {}).items():
        # A step's runs against its tier cap are its attempts that ended. A spawn that started no model leaves its one
        # attempt open, and a resume carries on with that same attempt (JP-183), so it uses none; before JP-183 each
        # refusal abandoned the attempt and the next began a new one, which spent the cap.
        rows = [r for r in walker.get("steps") or [] if r.get("step") == step]
        used = [r for r in rows if r.get("outcome") is not None]
        check("the walker counts {} run(s) of {} against its cap (attempts that ended)".format(want, step),
              len(used) == want and bool(rows),
              {"attempts": rows, "runs": (walker.get("runs") or {}).get(step), "stopped": walker.get("stopped")})
    for step, want in (expect.get("step_outcomes") or {}).items():
        rows = [r for r in walker.get("steps") or [] if r.get("step") == step]
        check("the walker recorded {} with the outcome {}".format(step, want), any(r.get("outcome") == want for r in rows),
              {"rows": rows, "stopped": walker.get("stopped")})
    if "graph_runner_within_seconds" in expect:
        checks.extend(_pace(laptop, expect))
    if "jira_path" in expect:
        changes = ((read_json(laptop.jira / "fake-jira.json") or {}).get("changelogs") or {}).get(laptop.ticket) or []
        path = [item.get("toString") for change in changes for item in change.get("items") or []
                if item.get("field") == "status"]
        check("the ticket went {} in that order, each move one the JP snapshot allows".format(", ".join(expect["jira_path"])),
              path == expect["jira_path"][1:] and _first_status(laptop, doc) == expect["jira_path"][0],
              {"moves": path, "want": expect["jira_path"]})
    if "pull_request" in expect:
        checks.extend(_pull_request(laptop, expect["pull_request"]))
    if expect.get("nothing_left"):
        checks.append(_nothing_left(laptop))
    if "hand_over_within_passes" in expect:
        checks.append(_hand_over(laptop, doc, int(expect["hand_over_within_passes"])))
    return checks


def _first_status(laptop: Laptop, doc: dict) -> Optional[str]:
    return ((doc.get("fixture") or {}).get("status")) or "Ready"


def _pull_request(laptop: Laptop, want: dict) -> List[dict]:
    """JP-198: the stand-in gh's log and state show one pull request opened from the ticket's branch and merged, and
    every call the gates and the loose-ends reader made was one it knows."""
    calls = laptop.gh_calls()
    def ok(*words):
        return [c for c in calls if c.get("code") == 0 and c.get("argv")[:len(words)] == list(words)]

    created, merged = ok("pr", "create"), ok("pr", "merge")
    prs = list((laptop.gh_state().get("prs") or {}).values())
    prefix = want.get("branch_prefix", laptop.ticket + "-")
    heads = [str(_option(c["argv"], "--head")) for c in created]
    main = laptop.git(laptop.origin, "rev-parse", "refs/heads/main")
    landed = [p for p in prs if p.get("state") == "MERGED" and p.get("merge_commit") and main and
              laptop.git(laptop.origin, "merge-base", "--is-ancestor", p["merge_commit"], main) is not None]
    unknown = [c for c in calls if "unknown call" in " ".join(c.get("said") or []) or "bad call" in " ".join(
        c.get("said") or [])]
    return [{"check": "the stand-in gh opened {} pull request(s) and merged {}, from a branch starting {}".format(
                 want.get("opened", 1), want.get("merged", 1), prefix),
             "ok": len(created) == int(want.get("opened", 1)) and len(merged) == int(want.get("merged", 1))
             and bool(heads) and all(h.startswith(prefix) for h in heads) and len(landed) == int(want.get("merged", 1)),
             "detail": {"created": heads, "merges": len(merged), "on_main": [p.get("merge_commit") for p in landed],
                        "prs": [{k: p.get(k) for k in ("number", "head", "state", "labels", "merge_commit")} for p in prs]}},
            {"check": "every gh call was one the stand-in knows", "ok": bool(calls) and not unknown,
             "detail": {"calls": len(calls), "unknown": unknown[:5]}}]


def _option(argv: List[str], name: str) -> Optional[str]:
    return argv[argv.index(name) + 1] if name in argv and argv.index(name) + 1 < len(argv) else None


def _nothing_left(laptop: Laptop) -> dict:
    """JP-174 after a merge: no worktree, local branch or remote branch for the ticket is left."""
    prefix = laptop.ticket + "-"
    trees = [line[len("worktree "):] for line in (laptop.git(laptop.clone, "worktree", "list", "--porcelain") or
                                                   "").splitlines() if line.startswith("worktree ")]
    left_trees = [t for t in trees if Path(t).resolve() != laptop.clone.resolve()]
    folders = sorted(str(p) for p in (laptop.clone / ".claude" / "worktrees").glob(prefix + "*"))
    local = (laptop.git(laptop.clone, "branch", "--list", prefix + "*") or "").split()
    remote = (laptop.git(laptop.origin, "for-each-ref", "--format=%(refname)", "refs/heads/" + prefix + "*") or "").split()
    readable = laptop.clone.is_dir() and laptop.git(laptop.clone, "rev-parse", "--git-dir") is not None
    return {"check": "no worktree or branch for {} is left, here or on the stand-in GitHub".format(laptop.ticket),
            "ok": readable and not left_trees and not folders and not local and not remote,
            "detail": {"worktrees": left_trees, "folders": folders, "local_branches": local, "remote_branches": remote}}


def _hand_over(laptop: Laptop, doc: dict, within: int) -> dict:
    """JP-168's hand-over: within `within` passes of the run ending, a validation run for the ticket is open."""
    passes = _lines(laptop.evidence / "passes.jsonl")
    ended_at = next((p["pass"] for p in passes if p.get("ended")), None)
    seen_at = next((p["pass"] for p in passes for r in p.get("ticket_runs") or []
                    if r.get("graph") == "validation"), None)
    now = [r for r in laptop.ticket_runs() if r["graph"] == "validation"]
    ok = ended_at is not None and seen_at is not None and seen_at <= ended_at + within and \
        any(r["ended"] is None for r in now)
    return {"check": "a validation run for {} started within {} pass(es) of the {} run ending, and is open".format(
                laptop.ticket, within, doc["graph"]),
            "ok": ok, "detail": {"run_ended_in_pass": ended_at, "validation_run_first_seen_in_pass": seen_at,
                                 "validation_runs": now or "none: the missing validation run"}}


def _stamps(log: Path) -> List[float]:
    """When each run of a job began, from the `=== <time> exit <code>` lines the job runner writes."""
    out = []
    for line in log.read_text(encoding="utf-8").splitlines() if log.is_file() else []:
        if line.startswith("=== "):
            try:
                at = datetime.datetime.strptime(line.split()[1], "%Y-%m-%dT%H:%M:%SZ")
            except (IndexError, ValueError):
                continue
            out.append(at.replace(tzinfo=datetime.timezone.utc).timestamp())
    return out


def _pace(laptop: Laptop, expect: dict) -> List[dict]:
    """JP-181: in every pass, graph-runner starts within the bound of the pass starting, though ledger-record ahead of
    it had more work than its budget. Times are the laptop's clock, from the passes and the job logs."""
    bound, busy = float(expect["graph_runner_within_seconds"]), float(expect.get("ledger_record_busy_seconds", 0))
    logs = laptop.josh / "logs"
    runner, record = _stamps(logs / "graph-runner.log"), _stamps(logs / "ledger-record.log")
    passes = _lines(laptop.evidence / "passes.jsonl")
    rows = []
    for n, line in enumerate(passes):
        began = float(line["started_at"])
        until = float(passes[n + 1]["started_at"]) if n + 1 < len(passes) else float("inf")
        ran = next((t for t in runner if began - 1 <= t < until), None)
        rec = next((t for t in record if began - 1 <= t < until), None)
        rows.append({"pass": line["pass"], "graph_runner_after_seconds": None if ran is None else round(ran - began),
                     "ledger_record_seconds": None if ran is None or rec is None else round(ran - rec)})
    found = [r for r in rows if r["graph_runner_after_seconds"] is not None]
    out = [{"check": "graph-runner started within {:g} seconds of e2e time in every pass".format(bound),
            "ok": bool(rows) and len(found) == len(rows) and all(r["graph_runner_after_seconds"] <= bound for r in rows),
            "detail": rows}]
    if busy:
        out.append({"check": "ledger-record ran ahead of it for at least {:g} seconds in every pass (the backlog was "
                             "big enough)".format(busy),
                    "ok": bool(rows) and all((r["ledger_record_seconds"] or 0) >= busy for r in rows), "detail": rows})
    return out


def _binding(laptop: Laptop):
    spec = importlib.util.spec_from_file_location("e2e_binding", str(ROOT / "graphs" / "bindings" / "agent-manager" /
                                                                    "binding.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)                                      # type: ignore[union-attr]
    return module


def _lines(path: Path) -> List[dict]:
    if not path.is_file():
        return []
    return [json.loads(x) for x in path.read_text(encoding="utf-8").splitlines() if x.strip()]


def _brief(row: dict) -> dict:
    return {k: row.get(k) for k in ("id", "name", "group_name", "archived", "status")}


# -- the command line ------------------------------------------------------------------------------------------------

def run_scenario(name: str, evidence: Optional[Path], run: Optional[str], python: str, am_bin: Path,
                 limit_minutes: Optional[float], wall_limit: float, allow_dirty: bool, keep: bool) -> dict:
    """Launch a sandbox laptop, drive the scenario, collect the evidence and judge it. Returns the verdict."""
    doc = scenario(name)
    run = run or "e2e-{}-{}".format(name, stamp())
    evidence = evidence or (ROOT / "docs" / "proof" / datetime.date.today().isoformat() / "e2e" / run)
    evidence.mkdir(parents=True, exist_ok=True)
    meta = launch(run, evidence, allow_dirty)
    laptop = Laptop(meta, am_bin, python, doc, evidence)
    try:
        laptop.setup()
        outcome = drive(laptop, doc, evidence / "passes.jsonl", limit_minutes or float(doc.get("limit_minutes", 120)),
                        wall_limit)
        run_id = laptop.run_id()
        seen = collect(laptop, evidence, run_id)
        checks = judge(laptop, doc, run_id, outcome, seen)
    finally:
        if not keep:
            laptop.stop()
    verdict = {"ok": bool(checks) and all(c["ok"] for c in checks), "scenario": name, "about": doc.get("about"),
               "run": run_id, "sandbox": meta["root"], "commit": meta["commit"], "python": python,
               "agent_manager": agent_manager.PINNED, "drive": outcome, "checks": checks, "evidence": str(evidence)}
    write_json(evidence / "verdict.json", verdict)
    if not keep:
        shutil.rmtree(str(laptop.root), ignore_errors=True)
    return verdict


def main(argv: List[str]) -> int:
    parser = argparse.ArgumentParser(prog="e2e.py", description=__doc__.split("\n\n")[0])
    parser.add_argument("--scenario", help="a file in tests/e2e/runs/, without .json")
    parser.add_argument("--all", action="store_true", help="every scenario, each in <evidence>/<scenario>/")
    parser.add_argument("--evidence", help="where the evidence goes (default docs/proof/<date>/e2e/<run>)")
    parser.add_argument("--run", help="the sandbox's run id (default e2e-<scenario>-<time>)")
    parser.add_argument("--python", help="the laptop's Python 3.9 (default: found)")
    parser.add_argument("--limit-minutes", type=float, help="e2e minutes before giving up (default: the scenario's)")
    parser.add_argument("--wall-limit", type=float, default=1200.0, help="real seconds before giving up")
    parser.add_argument("--allow-dirty", action="store_true", help="drive committed HEAD of a dirty checkout")
    parser.add_argument("--keep", action="store_true", help="leave the sandbox and Agent Manager running after")
    parser.add_argument("--list", action="store_true", help="list the scenarios and exit")
    a = parser.parse_args(argv)
    if a.list:
        print(json.dumps({n: d.get("about", "") for n, d in scenarios().items()}, indent=1, sort_keys=True))
        return 0
    if bool(a.scenario) == bool(a.all):
        parser.error("name one --scenario, or --all (or --list)")
    names = list(scenarios()) if a.all else [a.scenario]
    try:
        for name in names:
            scenario(name)
        am_bin = check_tools()
        python = find_python(a.python)
    except (Problem, agent_manager.Problem, OSError, subprocess.SubprocessError) as err:
        print(json.dumps({"ok": False, "error": str(err)}, indent=1))
        return 2
    verdicts = []
    base = Path(a.evidence).absolute() if a.evidence else None
    for name in names:
        evidence = (base / name if a.all else base) if base else None
        try:
            verdicts.append(run_scenario(name, evidence, None if a.all else a.run, python, am_bin, a.limit_minutes,
                                         a.wall_limit, a.allow_dirty, a.keep))
        except (Problem, agent_manager.Problem, OSError, subprocess.SubprocessError) as err:
            print(json.dumps({"ok": False, "scenario": name, "error": str(err)}, indent=1))
            return 2
    if a.all:
        summary = {"ok": all(v["ok"] for v in verdicts),
                   "scenarios": {v["scenario"]: {"ok": v["ok"], "failed": [c["check"] for c in v["checks"] if not c["ok"]],
                                                 "evidence": v["evidence"]} for v in verdicts}}
        if base:
            write_json(base / "summary.json", summary)
        print(json.dumps(summary, indent=1, sort_keys=True))
        return 0 if summary["ok"] else 1
    print(json.dumps(verdicts[0], indent=1, sort_keys=True))
    return 0 if verdicts[0]["ok"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
